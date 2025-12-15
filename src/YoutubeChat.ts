import { IHTTPMethods, Router } from 'itty-router';
import { Env } from '.';
import { LiveChatAction, ChatItemRenderer, Continuation } from '@util/types';
import { traverseJSON } from '@util/util';
import { getContinuationToken, VideoData, COMMON_HEADERS } from '@util/youtube';
import { MessageAdapter } from './adapters';
import { JSONMessageAdapter } from './adapters/json';
import { IRCMessageAdapter } from './adapters/irc';
import { RawMessageAdapter } from './adapters/raw';
import { TruffleMessageAdapter } from './adapters/truffle';
import { SubathonMessageAdapter } from './adapters/subathon';

// --- Type Definitions ---
type ClientMsg = { type: 'adapter'; adapter: string };
type Msg =
	| { type: 'ping' }
	| {
			type: 'message';
			message: string;
			id: string;
			author: { id: string; name: string; badges: { tooltip: string; type: string; badge: string }[] };
			unix: number;
	  }
	| { debug: true; message: string };

class AdapterInfo {
	sockets: Set<WebSocket> = new Set();
}

// --- Main Worker Logic ---

export async function createChatObject(
	videoId: string,
	videoData: VideoData,
	req: Request,
	env: Env
): Promise<Response> {
	const id = env.CHAT_DB.idFromName(videoId);
	const object = env.CHAT_DB.get(id);

	// Pass videoId via header so the DO knows which video to auto-heal
	const initHeaders = new Headers({ 'Content-Type': 'application/json' });
	initHeaders.set('X-Video-Id', videoId);

	const init = await object.fetch('http://youtube.chat/init', {
		method: 'POST',
		headers: initHeaders,
		body: JSON.stringify(videoData),
	});
	if (!init.ok) return init;

	const url = new URL(req.url);
	
	// Forward the websocket request, injecting X-Video-Id header
	const wsHeaders = new Headers(req.headers);
	wsHeaders.set('X-Video-Id', videoId);
	const forwardedReq = new Request(req, { headers: wsHeaders });

	// Route to /ws/<videoId> to ensure DO context is set
	return object.fetch(`http://youtube.chat/ws/${videoId}${url.search}`, forwardedReq);
}

export class YoutubeChatV4 implements DurableObject {
	private adapters: Map<string, AdapterInfo> = new Map();
	private nextContinuationToken: string | null = null;
	
	// State for Deadman Switch & Auto-Heal
	private lastOkFetchTime = Date.now();
	private consecutiveEmptyPolls = 0;
	private tokenStallSince = Date.now();
	private healBackoffMs = 5_000;
	private nextHealAllowedAt = 0;

	// Session Data
	private initialized = false;
	private videoId: string | null = null;
	private apiKey!: string;
	private clientVersion!: string;
	private visitorData!: string;
	private initialData!: VideoData['initialData'];

	// Memory & Time Barriers
	private recentMessageIds = new Set<string>();
	private bootTime = Date.now();

	// Timing Constants
	private static readonly BASE_CHAT_INTERVAL = 3_000;
	private static readonly MIN_CHAT_INTERVAL = 1_000;
	private static readonly MAX_CHAT_INTERVAL = 20_000;

	constructor(private state: DurableObjectState, private env: Env) {
		// Keep sockets alive with pings
		setInterval(() => this.sendPing(), 30_000);
	}

	async fetch(req: Request): Promise<Response> {
		const r = Router();
		r.post('/init', (req: Request) => this.handleInit(req));
		r.get('/ws/:videoId', (req: Request) => this.handleWebsocket(req));
		r.get('/ws', (req: Request) => this.handleWebsocket(req));
		r.all('*', () => new Response('Not found', { status: 404 }));
		return r.handle(req);
	}

	// --- ALARM HANDLER (Runs in a fresh invocation = Reset Subrequest Limit) ---
	async alarm(): Promise<void> {
		await this.state.blockConcurrencyWhile(async () => {
			const delay = await this.pollOnce();
			await this.scheduleNext(delay);
		});
	}

	// --- POLLING LOGIC ---
	private async pollOnce(): Promise<number> {
		if (!this.initialized || !this.nextContinuationToken) return 2_000;
		if (!this.hasActiveSockets()) return 0; // Stop polling if no listeners

		const now = Date.now();
		const msSinceOk = now - this.lastOkFetchTime;

		// DEADMAN SWITCH: Check if we are stale
		if (msSinceOk > 45_000 && now >= this.nextHealAllowedAt) {
			this.broadcast({ debug: true, message: '♻️ [AUTO-HEAL] Refreshing token...' });

			const recovered = await this.forceRefreshSession();
			if (!recovered) {
				this.broadcast({ debug: true, message: '⚠️ [AUTO-HEAL] Token refresh failed.' });
				this.healBackoffMs = Math.min(this.healBackoffMs * 2, 60_000); // Exponential backoff
				this.nextHealAllowedAt = now + this.healBackoffMs;
				return this.healBackoffMs;
			}

			// Success! Reset backoff
			this.healBackoffMs = 5_000;
			this.nextHealAllowedAt = now + 5_000;
		}

		const token = this.nextContinuationToken;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);

		try {
			// Fetch from YouTube (Using SCRAPED API Key, not ENV)
			const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}`;

			const res = await fetch(url, {
				method: 'POST',
				headers: COMMON_HEADERS,
				body: JSON.stringify({
					context: {
						client: {
							clientName: 'WEB',
							clientVersion: this.clientVersion, // Use scraped version
							hl: 'en',
							gl: 'US',
							visitorData: this.visitorData,
							userAgent: COMMON_HEADERS['User-Agent'],
							osName: 'Windows',
							osVersion: '10.0',
							platform: 'DESKTOP',
						},
					},
					continuation: token,
					currentPlayerState: { playerOffsetMs: '0' },
				}),
				signal: controller.signal,
			});

			if (!res.ok) throw new Error(`Status ${res.status}`);

			const data = await res.json<any>();
			this.lastOkFetchTime = Date.now(); // Mark success

			const { token: nextToken, timeoutMs } = this.extractContinuationAndTimeout(data);
			if (nextToken) this.nextContinuationToken = nextToken;

			const actions = data?.continuationContents?.liveChatContinuation?.actions ?? [];
			
			// Process Messages
			for (const action of actions) {
				// Time Barrier
				let msgTimestamp = 0;
				try {
					const renderer =
						action.liveChatTextMessageRenderer ||
						action.liveChatPaidMessageRenderer ||
						action.liveChatMembershipItemRenderer;
					if (renderer && renderer.timestampUsec) {
						msgTimestamp = parseInt(renderer.timestampUsec) / 1000;
					}
				} catch (e) {}

				if (msgTimestamp > 0 && msgTimestamp < this.bootTime - 5000) continue;

				const id = this.getId(action);
				if (id) {
					if (!this.trackMessageId(id)) continue;
				}
				
				// Transform and Broadcast
				this.processAndBroadcast(action, id);
			}

			if (typeof timeoutMs === 'number') return this.clamp(timeoutMs);
			return YoutubeChatV4.BASE_CHAT_INTERVAL;

		} catch (err: any) {
			const msg = (err && err.message) ? String(err.message) : String(err);
			if (msg.includes('Too many subrequests')) {
				this.broadcast({ debug: true, message: '⚠️ [FETCH] Subrequest limit hit (Alarm will reset).' });
				return 5_000;
			}
			this.broadcast({ debug: true, message: `⚠️ [FETCH] ${msg}` });
			return 5_000;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// --- HELPER METHODS ---

	private processAndBroadcast(action: any, id: string | undefined) {
		// Basic Text Message
		if (action.addChatItemAction?.item?.liveChatTextMessageRenderer) {
			const renderer = action.addChatItemAction.item.liveChatTextMessageRenderer;
			const message = renderer.message?.runs?.map((r: any) => r.text).join('') || "";
			const authorName = renderer.authorName?.simpleText || "Unknown";
			const authorId = renderer.authorExternalChannelId || "";
			const badges = renderer.authorBadges?.map((b: any) => ({
				tooltip: b.liveChatAuthorBadgeRenderer?.tooltip,
				type: b.liveChatAuthorBadgeRenderer?.icon?.iconType || 'icon',
				badge: b.liveChatAuthorBadgeRenderer?.customThumbnail?.thumbnails?.[0]?.url
			})) || [];
			
			this.broadcast({
				type: 'message',
				message,
				id: id || '',
				author: { id: authorId, name: authorName, badges },
				unix: Date.now()
			});
		}
	}

	private async scheduleNext(delayMs: number): Promise<void> {
		if (!this.hasActiveSockets()) {
			await this.state.storage.deleteAlarm();
			return;
		}
		const d = Math.max(YoutubeChatV4.MIN_CHAT_INTERVAL, delayMs || YoutubeChatV4.BASE_CHAT_INTERVAL);
		await this.state.storage.setAlarm(Date.now() + d);
	}

	private async forceRefreshSession(): Promise<boolean> {
		const vid = this.videoId;
		if (!vid) return false;

		try {
			const url = `https://www.youtube.com/live_chat?is_popout=1&v=${vid}`;
			const res = await fetch(url, { headers: COMMON_HEADERS });
			if (!res.ok) return false;

			const text = await res.text();
			const m = text.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});/s) ?? text.match(/var\s+ytInitialData\s*=\s*(\{.*?\});/s);
			if (!m) return false;

			const initialData = JSON.parse(m[1]);
			const { token } = this.extractContinuationAndTimeout(initialData);
			if (!token) return false;

			this.nextContinuationToken = token;
			this.lastOkFetchTime = Date.now();
			this.bootTime = Date.now(); // Reset time barrier
			return true;
		} catch {
			return false;
		}
	}

	private async handleInit(req: Request): Promise<Response> {
		const headerVid = req.headers.get('X-Video-Id');
		if (headerVid) this.videoId = headerVid;

		await this.state.blockConcurrencyWhile(async () => {
			if (this.initialized) return;
			try {
				const videoData = await req.json<VideoData>();
				this.apiKey = videoData.apiKey;
				this.clientVersion = videoData.clientVersion;
				this.visitorData = videoData.visitorData;
				this.initialData = videoData.initialData;
				this.nextContinuationToken = getContinuationToken(traverseJSON(this.initialData, (v) => v.title === 'Live chat' ? v.continuation : undefined));
				this.initialized = true;
				this.broadcast({ debug: true, message: 'Initialized stream session.' });
			} catch(e) {
				this.broadcast({ debug: true, message: 'Init failed' });
			}
		});
		return new Response('OK');
	}

	// --- REPLACED handleWebsocket FUNCTION (Starts polling immediately) ---
	private async handleWebsocket(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const parts = url.pathname.split('/');
		const urlVid = parts[parts.length - 1];
		if (urlVid && urlVid !== 'ws') this.videoId = urlVid;
		const headerVid = req.headers.get('X-Video-Id');
		if (headerVid) this.videoId = headerVid;

		const { 0: client, 1: server } = new WebSocketPair();
		const socket = server as WebSocket;
		socket.accept();

		// Adapter is selected via URL query (optional): ?adapter=json
		// Default to "json" so WebSocket King/Resonite "just works".
		const adapterName = url.searchParams.get('adapter') || 'json';

		let adapter = this.adapters.get(adapterName);
		if (!adapter) {
			adapter = new AdapterInfo();
			this.adapters.set(adapterName, adapter);
		}
		adapter.sockets.add(socket);

		// Kickstart polling immediately (no client handshake required)
		void this.scheduleNext(1_000);

		socket.send(JSON.stringify({ debug: true, message: `Connected. Listening for chat... (adapter=${adapterName})` }));

		const cleanup = () => {
			const currentAdapter = this.adapters.get(adapterName);
			currentAdapter?.sockets.delete(socket);
			if (currentAdapter && currentAdapter.sockets.size === 0) this.adapters.delete(adapterName);

			if (!this.hasActiveSockets()) void this.state.storage.deleteAlarm();
		};

		// The new code ignores any incoming messages (no dynamic adapter switching)
		socket.addEventListener('close', cleanup);
		socket.addEventListener('error', cleanup);

		return new Response(null, { status: 101, webSocket: client as any });
	}

	// --- UTILS ---
	private getId(data: LiveChatAction) {
		try {
			const cleanData = { ...data };
			delete (cleanData as any).clickTrackingParams;
			const actionType = Object.keys(cleanData)[0] as keyof LiveChatAction;
			const action = (cleanData as any)[actionType]?.item;
			return action?.id;
		} catch (e) { return undefined; }
	}

	private trackMessageId(id: string): boolean {
		if (this.recentMessageIds.has(id)) return false;
		this.recentMessageIds.add(id);
		if (this.recentMessageIds.size > 50) {
			const first = this.recentMessageIds.values().next().value;
			this.recentMessageIds.delete(first);
		}
		return true;
	}

	private extractContinuationAndTimeout(data: any) {
		const conts = data?.continuationContents?.liveChatContinuation?.continuations ?? data?.continuationContents?.liveChatContinuation?.continuations?.[0];
		const arr = Array.isArray(conts) ? conts : [];
		for (const c of arr) {
			const timed = c?.timedContinuationData ?? c?.invalidationContinuationData ?? c?.reloadContinuationData;
			if (timed?.continuation) return { token: String(timed.continuation), timeoutMs: timed.timeoutMs };
		}
		const fallback = traverseJSON(data, (v, k) => k === 'continuation' && typeof v === 'string' ? v : undefined);
		return { token: fallback, timeoutMs: null };
	}

	private traverseJSONForContinuation(obj: any): string | null {
		// Helper used by extractContinuation fallback
		return traverseJSON(obj, (v, k) => k === 'continuation' && typeof v === 'string' ? v : undefined) || null;
	}

	private clamp(ms: number) { return Math.max(YoutubeChatV4.MIN_CHAT_INTERVAL, Math.min(YoutubeChatV4.MAX_CHAT_INTERVAL, ms)); }
	private hasActiveSockets() { for (const a of this.adapters.values()) { if (a.sockets.size > 0) return true; } return false; }
	
	private broadcast(msg: Msg) {
		const text = JSON.stringify(msg);
		this.adapters.forEach(adapter => adapter.sockets.forEach(sock => this.safeSend(sock, text)));
	}
	private safeSend(socket: WebSocket, data: string) { try { socket.send(data); } catch { try { socket.close(); } catch {} } }
	private sendPing() { if (!this.hasActiveSockets()) return; this.broadcast({ type: 'ping' }); }
}

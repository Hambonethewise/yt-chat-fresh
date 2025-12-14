// src/YoutubeChat.ts
import { Router } from 'itty-router';
import { VideoData } from './util/youtube';

export async function createChatObject(
	videoId: string,
	videoData: VideoData,
	req: Request,
	env: Env
): Promise<Response> {
	const id = env.CHAT_DB.idFromName(videoId);
	const object = env.CHAT_DB.get(id);

	// Pass videoId into the DO via a header so auto-heal always has it
	const initHeaders = new Headers({ 'Content-Type': 'application/json' });
	initHeaders.set('X-Video-Id', videoId);

	const initRes = await object.fetch('http://youtube.chat/init', {
		method: 'POST',
		headers: initHeaders,
		body: JSON.stringify(videoData)
	});

	if (initRes.status !== 200) {
		return new Response(await initRes.text(), { status: initRes.status });
	}

	const url = new URL(req.url);

	// Forward the websocket request, also injecting X-Video-Id
	const wsHeaders = new Headers(req.headers);
	wsHeaders.set('X-Video-Id', videoId);

	const forwardedReq = new Request(req, { headers: wsHeaders });

	return object.fetch('http://youtube.chat/ws' + url.search, forwardedReq);
}

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

export class YoutubeChatV3 implements DurableObject {
	private adapters: Map<string, AdapterInfo> = new Map();
	private nextContinuationToken: string | null = null;
	private lastOkFetchTime = Date.now(); // <-- track last successful poll, not last message
	private initialized = false;
	private videoId: string | null = null;

	private healBackoffMs = 5_000;
	private nextHealAllowedAt = 0;

	private static readonly BASE_CHAT_INTERVAL = 3_000;
	private static readonly MIN_CHAT_INTERVAL = 1_000;
	private static readonly MAX_CHAT_INTERVAL = 20_000;

	constructor(private state: DurableObjectState, private env: Env) {
		// Keep sockets alive and make sure clients see we're still here
		setInterval(() => this.sendPing(), 30_000);
	}

	async fetch(req: Request): Promise<Response> {
		const r = Router();
		r.post('/init', (req: Request) => this.handleInit(req));
		r.get('/ws', (req: Request) => this.handleWebsocket(req));
		return r.fetch(req);
	}

	// Durable Object Alarm handler: runs polling in fresh invocations
	async alarm(): Promise<void> {
		await this.state.blockConcurrencyWhile(async () => {
			const delay = await this.pollOnce();
			await this.scheduleNext(delay);
		});
	}

	private broadcast(msg: Msg) {
		const text = JSON.stringify(msg);
		this.adapters.forEach(adapter => adapter.sockets.forEach(sock => sock.send(text)));
	}

	private sendPing() {
		if (!this.hasActiveSockets()) return;
		this.broadcast({ type: 'ping' });
	}

	private getAdapter(name: string): AdapterInfo {
		let adapter = this.adapters.get(name);
		if (!adapter) {
			adapter = new AdapterInfo();
			this.adapters.set(name, adapter);
		}
		return adapter;
	}

	private hasActiveSockets(): boolean {
		for (const a of this.adapters.values()) {
			if (a.sockets.size > 0) return true;
		}
		return false;
	}

	private async ensurePollingScheduled(): Promise<void> {
		if (!this.hasActiveSockets()) return;

		const current = await this.state.storage.getAlarm();
		if (current == null) {
			// schedule immediately
			await this.state.storage.setAlarm(Date.now() + 1);
		}
	}

	private async scheduleNext(delayMs: number): Promise<void> {
		if (!this.hasActiveSockets()) {
			await this.state.storage.deleteAlarm();
			return;
		}
		const d = Math.max(YoutubeChatV3.MIN_CHAT_INTERVAL, delayMs || YoutubeChatV3.BASE_CHAT_INTERVAL);
		await this.state.storage.setAlarm(Date.now() + d);
	}

	private clamp(ms: number): number {
		return Math.max(YoutubeChatV3.MIN_CHAT_INTERVAL, Math.min(YoutubeChatV3.MAX_CHAT_INTERVAL, ms));
	}

	private extractContinuationAndTimeout(data: any): { token: string | null; timeoutMs: number | null } {
		const conts =
			data?.continuationContents?.liveChatContinuation?.continuations ??
			data?.continuationContents?.liveChatContinuation?.continuations?.[0];

		// Prefer the official timedContinuationData/invalidationContinuationData path
		const arr = Array.isArray(conts) ? conts : [];
		for (const c of arr) {
			const timed = c?.timedContinuationData ?? c?.invalidationContinuationData ?? c?.reloadContinuationData;
			if (timed?.continuation) {
				return {
					token: String(timed.continuation),
					timeoutMs: typeof timed.timeoutMs === 'number' ? timed.timeoutMs : null
				};
			}
		}

		// Fallback: recursive search
		const fallback = this.traverseJSONForContinuation(data);
		return { token: fallback, timeoutMs: null };
	}

	private traverseJSONForContinuation(obj: any): string | null {
		const stack: any[] = [obj];
		while (stack.length) {
			const cur = stack.pop();
			if (cur && typeof cur === 'object') {
				if (typeof cur.continuation === 'string') return cur.continuation;
				for (const k in cur) stack.push(cur[k]);
			}
		}
		return null;
	}

	private async pollOnce(): Promise<number> {
		if (!this.initialized || !this.nextContinuationToken) return 2_000;
		if (!this.hasActiveSockets()) return 0;

		// Deadman: only heal if we haven't had a successful poll in a while (not just "no chat messages")
		const now = Date.now();
		const msSinceOk = now - this.lastOkFetchTime;
		if (msSinceOk > 45_000 && now >= this.nextHealAllowedAt) {
			this.broadcast({ debug: true, message: '♻️ [AUTO-HEAL] Refreshing token...' });

			const recovered = await this.forceRefreshSession();
			if (!recovered) {
				this.broadcast({ debug: true, message: '⚠️ [AUTO-HEAL] Token refresh failed.' });

				// exponential backoff on heal attempts
				this.healBackoffMs = Math.min(this.healBackoffMs * 2, 60_000);
				this.nextHealAllowedAt = now + this.healBackoffMs;

				return this.healBackoffMs;
			}

			// success resets backoff
			this.healBackoffMs = 5_000;
			this.nextHealAllowedAt = now + 5_000;
		}

		const token = this.nextContinuationToken;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);

		try {
			const url = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=' + this.env.YT_API_KEY;

			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' } },
					continuation: token
				}),
				signal: controller.signal
			});

			if (!res.ok) {
				throw new Error(`Status ${res.status}`);
			}

			const data = await res.json<any>();

			// Mark success even if chat is quiet
			this.lastOkFetchTime = Date.now();

			const { token: nextToken, timeoutMs } = this.extractContinuationAndTimeout(data);
			if (nextToken) this.nextContinuationToken = nextToken;

			const actions = data?.continuationContents?.liveChatContinuation?.actions ?? [];
			for (const action of actions) {
				try {
					const item = action?.addChatItemAction?.item;
					const renderer = item?.liveChatTextMessageRenderer;
					if (!renderer) continue;

					const message =
						renderer?.message?.runs?.map((r: any) => r?.text).filter(Boolean).join('') ?? '';

					const authorName = renderer?.authorName?.simpleText ?? '';
					const authorId = renderer?.authorExternalChannelId ?? '';
					const id = renderer?.id ?? '';
					const unix = renderer?.timestampUsec ? Math.floor(Number(renderer.timestampUsec) / 1000) : Date.now();

					const badges =
						renderer?.authorBadges?.map((b: any) => ({
							tooltip: b?.liveChatAuthorBadgeRenderer?.tooltip ?? '',
							type: b?.liveChatAuthorBadgeRenderer?.icon?.iconType ?? 'unknown',
							badge: b?.liveChatAuthorBadgeRenderer?.customThumbnail?.thumbnails?.[0]?.url ?? ''
						})) ?? [];

					this.broadcast({
						type: 'message',
						message,
						id,
						author: { id: authorId, name: authorName, badges },
						unix
					});
				} catch {
					// ignore per-item parse failures
				}
			}

			// If YouTube gives us a recommended delay, use it
			if (typeof timeoutMs === 'number') return this.clamp(timeoutMs);

			return YoutubeChatV3.BASE_CHAT_INTERVAL;
		} catch (err: any) {
			const msg = (err && err.message) ? String(err.message) : String(err);

			if (msg.includes('Too many subrequests')) {
				this.broadcast({ debug: true, message: '⚠️ [FETCH] Too many subrequests.' });
				// Alarms will run in a fresh invocation, so just back off slightly
				return 5_000;
			}

			this.broadcast({ debug: true, message: `⚠️ [FETCH] ${msg}` });
			return 5_000;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async forceRefreshSession(): Promise<boolean> {
		const vid = this.videoId;
		if (!vid) return false;

		try {
			const url = `https://www.youtube.com/live_chat?is_popout=1&v=${vid}`;
			const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

			if (!res.ok) {
				this.broadcast({ debug: true, message: `⚠️ [AUTO-HEAL] live_chat HTTP ${res.status}` });
				return false;
			}

			const text = await res.text();

			// Make extraction newline-safe (dotAll)
			const m =
				text.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});/s) ??
				text.match(/var\s+ytInitialData\s*=\s*(\{.*?\});/s);

			if (!m) return false;

			const initialData = JSON.parse(m[1]);
			const token = this.traverseJSONForContinuation(initialData);
			if (!token) return false;

			this.nextContinuationToken = token;
			this.lastOkFetchTime = Date.now();
			return true;
		} catch {
			return false;
		}
	}

	private async handleInit(req: Request): Promise<Response> {
		// lock in videoId from header for reliable auto-heal
		const headerVid = req.headers.get('X-Video-Id');
		if (headerVid) this.videoId = headerVid;

		await this.state.blockConcurrencyWhile(async () => {
			if (this.initialized) return;

			const videoData = await req.json<VideoData>();

			this.nextContinuationToken = videoData.continuation;
			this.lastOkFetchTime = Date.now();
			this.initialized = true;

			this.broadcast({ debug: true, message: 'Initialized stream session.' });
		});

		return new Response('OK');
	}

	private async handleWebsocket(req: Request): Promise<Response> {
		// also accept videoId from header for safety
		const headerVid = req.headers.get('X-Video-Id');
		if (headerVid) this.videoId = headerVid;

		const { 0: client, 1: server } = new WebSocketPair();
		const socket = server as WebSocket;
		socket.accept();

		let adapterName: string | null = null;

		socket.addEventListener('message', (evt: MessageEvent) => {
			try {
				const msg = JSON.parse(evt.data as string) as ClientMsg;
				if (msg.type === 'adapter') {
					adapterName = msg.adapter || 'default';
					const adapter = this.getAdapter(adapterName);
					adapter.sockets.add(socket);

					this.broadcast({ debug: true, message: `Adapter registered: ${adapterName}` });

					// start alarm-driven polling once at least one client is connected
					this.state.waitUntil?.(this.ensurePollingScheduled());
					// If waitUntil isn't available in your types/runtime, the line above is a no-op.
					// Polling will still get scheduled by the next awaited call below.
					void this.ensurePollingScheduled();
				}
			} catch {
				// ignore
			}
		});

		socket.addEventListener('close', () => {
			if (adapterName) {
				const adapter = this.adapters.get(adapterName);
				adapter?.sockets.delete(socket);
				if (adapter && adapter.sockets.size === 0) {
					this.adapters.delete(adapterName);
				}
			}
			// Stop polling when nobody is connected
			if (!this.hasActiveSockets()) {
				void this.state.storage.deleteAlarm();
			}
		});

		socket.addEventListener('error', () => {
			if (adapterName) {
				const adapter = this.adapters.get(adapterName);
				adapter?.sockets.delete(socket);
				if (adapter && adapter.sockets.size === 0) {
					this.adapters.delete(adapterName);
				}
			}
			if (!this.hasActiveSockets()) {
				void this.state.storage.deleteAlarm();
			}
		});

		socket.send(JSON.stringify({ debug: true, message: 'Connected. Listening for chat...' }));

		return new Response(null, { status: 101, webSocket: client as any });
	}
}

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

const adapterMap: Record<string, (env: Env, channelId: string) => MessageAdapter> = {
	json: () => new JSONMessageAdapter(),
	irc: () => new IRCMessageAdapter(),
	truffle: (env, channelId) => new TruffleMessageAdapter(env, channelId),
	subathon: () => new SubathonMessageAdapter(),
	raw: () => new RawMessageAdapter(),
};

type Handler = (request: Request) => Promise<Response>;

export async function createChatObject(
	videoId: string,
	videoData: VideoData,
	req: Request,
	env: Env
): Promise<Response> {
	const id = env.CHAT_DB.idFromName(videoId);
	const object = env.CHAT_DB.get(id);
	
	const init = await object.fetch('http://youtube.chat/init', {
		method: 'POST',
		body: JSON.stringify(videoData),
	});
	if (!init.ok) return init;

	const url = new URL(req.url);
	return object.fetch('http://youtube.chat/ws' + url.search, req);
}

const BASE_CHAT_INTERVAL = 3000;

export class YoutubeChatV3 implements DurableObject {
	private router: Router<Request, IHTTPMethods>;
	private channelId!: string;
	private videoId!: string; // Saved to allow auto-recovery
	private initialData!: VideoData['initialData'];
	private apiKey!: string;
	private clientVersion!: string;
	private visitorData!: string;
	private seenMessages = new Map<string, number>();
	private isLoopRunning = false; 
	private nextContinuationToken?: string; 
	private emptyResponseCount = 0; // Tracks staleness

	constructor(private state: DurableObjectState, private env: Env) {
		const r = Router<Request, IHTTPMethods>();
		this.router = r;
		r.post('/init', this.init);
		r.get('/ws', this.handleWebsocket);
		r.all('*', () => new Response('Not found', { status: 404 }));

		// Keep the websocket alive
		setInterval(() => this.sendPing(), 30000); 
	}

	private sendPing() {
		const pingData = JSON.stringify({ type: 'ping' });
		for (const adapter of this.adapters.values()) {
			for (const socket of adapter.sockets) {
				this.safeSend(socket, pingData);
			}
		}
	}

	private safeSend(socket: WebSocket, data: string) {
		try {
			socket.send(data);
		} catch (e) {
			try { socket.close(); } catch(e) {}
		}
	}

	private broadcast(data: any) {
		for (const adapter of this.adapters.values()) {
			if (data.debug) {
				for (const socket of adapter.sockets) {
					this.safeSend(socket, JSON.stringify(data));
				}
				continue;
			}
			
			const transformed = adapter.transform(data);
			if (!transformed) continue;
			for (const socket of adapter.sockets) {
				this.safeSend(socket, transformed);
			}
		}
	}

	private initialized = false;
	private init: Handler = (req) => {
		return this.state.blockConcurrencyWhile(async () => {
			if (this.initialized) {
				try {
					const data = await req.json<VideoData>();
					const continuation = traverseJSON(data.initialData, (value) => {
						if (value.title === 'Live chat') return value.continuation as Continuation;
					});
					if (continuation) {
						const token = getContinuationToken(continuation);
						if (token) this.nextContinuationToken = token;
					}
				} catch(e) {}
				return new Response();
			}

			this.initialized = true;
			const data = await req.json<VideoData>();
			
			this.apiKey = data.apiKey;
			this.clientVersion = data.clientVersion;
			this.visitorData = data.visitorData; 
			this.initialData = data.initialData;
			
			this.channelId = traverseJSON(this.initialData, (value, key) => {
				if (key === 'channelNavigationEndpoint') return value.browseEndpoint?.browseId;
			}) || 'UNKNOWN';

			const continuation = traverseJSON(this.initialData, (value) => {
				if (value.title === 'Live chat') return value.continuation as Continuation;
			});

			if (!continuation) {
				this.initialized = false;
				return new Response('No continuation found', { status: 404 });
			}
			const token = getContinuationToken(continuation);
			if (!token) {
				this.initialized = false;
				return new Response('No token found', { status: 404 });
			}

			this.nextContinuationToken = token;

			if (!this.isLoopRunning) {
				this.fetchChat();
			}
			
			setInterval(() => this.clearSeenMessages(), 60 * 1000);
			return new Response();
		});
	};

	private async clearSeenMessages() {
		const cutoff = Date.now() - 1000 * 60;
		for (const [id, timestamp] of this.seenMessages.entries()) {
			if (timestamp < cutoff) this.seenMessages.delete(id);
		}
	}

	// --- AUTO-HEALING LOGIC ---
	private async recoverSession() {
		if (!this.videoId) return; 
		this.broadcast({ debug: true, message: "⚠️ [SELF-HEAL] Connection stale. Refreshing..." });
		
		try {
			// Re-scrape the video page to get a FRESH token
			const url = `https://www.youtube.com/live_chat?is_popout=1&v=${this.videoId}`;
			const response = await fetch(url, { headers: COMMON_HEADERS });
			const text = await response.text();
			
			// Simple Regex to find the initial data
			const match = text.match(/window\["ytInitialData"\]\s*=\s*({.+?});/);
			if (match && match[1]) {
				const json = JSON.parse(match[1]);
				const continuation = traverseJSON(json, (value) => {
					if (value.title === 'Live chat') return value.continuation as Continuation;
				});
				if (continuation) {
					const token = getContinuationToken(continuation);
					if (token) {
						this.nextContinuationToken = token;
						this.emptyResponseCount = 0;
						this.broadcast({ debug: true, message: "✅ [SELF-HEAL] Recovered with fresh token!" });
					}
				}
			}
		} catch (e) {
			this.broadcast({ debug: true, message: "❌ [SELF-HEAL] Failed." });
		}
	}

	private async fetchChat() {
		this.isLoopRunning = true; 
		let currentInterval = BASE_CHAT_INTERVAL;

		// 1. Check for Stale Connection
		if (this.emptyResponseCount > 5) {
			await this.recoverSession();
		}

		const tokenToUse = this.nextContinuationToken;

		if (!tokenToUse) {
			setTimeout(() => this.fetchChat(), 5000);
			return;
		}

		try {
			const controller = new AbortController();
			
			const payload = {
				context: {
					client: {
						clientName: "WEB",
						clientVersion: this.clientVersion,
						hl: "en",
						gl: "US",
						visitorData: this.visitorData, 
						userAgent: COMMON_HEADERS['User-Agent'],
						osName: "Windows",
						osVersion: "10.0",
						platform: "DESKTOP",
					}
				},
				continuation: tokenToUse, 
				currentPlayerState: { playerOffsetMs: "0" }
			};

			const fetchDataTask = async () => {
				const res = await fetch(
					`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}`,
					{ 
						method: 'POST', 
						headers: COMMON_HEADERS, 
						body: JSON.stringify(payload),
						redirect: 'manual',
						signal: controller.signal 
					}
				);
				if (!res.ok) throw new Error(`Status ${res.status}`);
				return await res.json<any>();
			};

			const timeoutPromise = new Promise<any>((_, reject) => 
				setTimeout(() => {
					controller.abort();
					reject(new Error("ForceTimeout"));
				}, 10000)
			);

			const data = await Promise.race([fetchDataTask(), timeoutPromise]);
			
			// 2. Process Data
			let actions: any[] = [];
			let hasData = false;
			
			if (data.continuationContents?.liveChatContinuation?.actions) {
				actions.push(...data.continuationContents.liveChatContinuation.actions);
				hasData = true;
			}
			if (data.onResponseReceivedEndpoints) {
				for (const endpoint of data.onResponseReceivedEndpoints) {
					const endpointActions = endpoint.appendContinuationItemsAction?.continuationItems;
					if (endpointActions) {
						actions.push(...endpointActions);
						hasData = true;
					}
					const reloadActions = endpoint.reloadContinuationItemsCommand?.continuationItems;
					if (reloadActions) {
						actions.push(...reloadActions);
						hasData = true;
					}
				}
			}

			// 3. Update Token
			const foundToken = traverseJSON(data, (value, key) => {
				if (key === "continuation" && typeof value === "string") {
					return value;
				}
			});

			if (foundToken) {
				this.nextContinuationToken = foundToken;
			}

			// 4. Track Staleness
			if (!hasData) {
				this.emptyResponseCount++;
			} else {
				this.emptyResponseCount = 0; // Reset on success
			}

			for (const action of actions) {
				const id = this.getId(action);
				if (id) {
					if (this.seenMessages.has(id)) continue;
					this.seenMessages.set(id, Date.now());
				}
				this.broadcast(action);
			}

		} catch (e: any) {
			if (e.message === "ForceTimeout" || e.name === 'AbortError') {
				this.broadcast({ debug: true, message: "⚠️ [ANTI-FREEZE] Download hung. Resetting..." });
			}
			currentInterval = 5000;
		} finally {
			setTimeout(() => this.fetchChat(), currentInterval);
		}
	}

	private getId(data: LiveChatAction) {
		try {
			const cleanData = { ...data };
			delete cleanData.clickTrackingParams;
			const actionType = Object.keys(cleanData)[0] as keyof LiveChatAction;
			const action = cleanData[actionType]?.item;
			if (!action) return undefined;
			const rendererType = Object.keys(action)[0] as keyof ChatItemRenderer;
			const renderer = action[rendererType] as { id?: string };
			return renderer?.id;
		} catch (e) { return undefined; }
	}

	private adapters = new Map<string, MessageAdapter>();
	private makeAdapter(adapterType: string): MessageAdapter {
		const adapterFactory = adapterMap[adapterType] ?? adapterMap.json!;
		const cached = this.adapters.get(adapterType);
		if (cached) return cached;
		const adapter = adapterFactory(this.env, this.channelId);
		this.adapters.set(adapterType, adapter);
		return adapter;
	}

	private handleWebsocket: Handler = async (req) => {
		if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a websocket', { status: 400 });
		const url = new URL(req.url);
		
		// Capture Video ID from URL for auto-recovery
		const parts = url.pathname.split('/');
		const possibleId = parts[parts.length - 1];
		if (possibleId && possibleId !== 'ws') this.videoId = possibleId;

		const adapterType = url.searchParams.get('adapter') ?? 'json';
		const pair = new WebSocketPair();
		const ws = pair[1];
		ws.accept();
		const adapter = this.makeAdapter(adapterType);
		adapter.sockets.add(ws);
		
		ws.send(JSON.stringify({ debug: true, message: "Connected. Listening for chat..." }));

		ws.addEventListener('close', () => {
			adapter.sockets.delete(ws);
			if (adapter.sockets.size === 0) this.adapters.delete(adapterType);
		});
		return new Response(null, { status: 101, webSocket: pair[0] });
	};

	async fetch(req: Request): Promise<Response> { return this.router.handle(req); }
}

// src/YoutubeChat.ts
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

	// ✅ Ensure the DO always knows the videoId (for auto-heal / refresh)
	const init = await object.fetch('http://youtube.chat/init', {
		method: 'POST',
		body: JSON.stringify({ ...videoData, videoId }),
	});
	if (!init.ok) return init;

	// ✅ Route websocket through the DO with the videoId in the path
	const url = new URL(req.url);
	return object.fetch(`http://youtube.chat/ws/${videoId}${url.search}`, req);
}

const BASE_CHAT_INTERVAL = 3000;

// Continuation extraction (prefer timedContinuationData)
function extractContinuation(data: any): { token?: string; timeoutMs?: number; kind?: string } {
	const conts = data?.continuationContents?.liveChatContinuation?.continuations;
	if (Array.isArray(conts)) {
		for (const c of conts) {
			if (c?.timedContinuationData?.continuation) {
				return {
					token: c.timedContinuationData.continuation,
					timeoutMs: Number(c.timedContinuationData.timeoutMs) || undefined,
					kind: 'timed',
				};
			}
		}
		for (const c of conts) {
			if (c?.invalidationContinuationData?.continuation) {
				return {
					token: c.invalidationContinuationData.continuation,
					timeoutMs: Number(c.invalidationContinuationData.timeoutMs) || undefined,
					kind: 'invalidation',
				};
			}
			if (c?.reloadContinuationData?.continuation) {
				return {
					token: c.reloadContinuationData.continuation,
					timeoutMs: Number(c.reloadContinuationData.timeoutMs) || undefined,
					kind: 'reload',
				};
			}
		}
	}

	// Fallback (last resort): keep your old behavior, but only if nothing else found
	const foundToken = traverseJSON(data, (value, key) => {
		if (key === 'continuation' && typeof value === 'string') return value;
	});
	return { token: foundToken, kind: foundToken ? 'fallback' : undefined };
}

export class YoutubeChatV3 implements DurableObject {
	private router: Router<Request, IHTTPMethods>;
	private channelId!: string;
	private videoId!: string;
	private initialData!: VideoData['initialData'];
	private apiKey!: string;
	private clientVersion!: string;
	private visitorData!: string;

	// STRICT MEMORY CONTROL
	private recentMessageIds = new Set<string>();
	private isLoopRunning = false;
	private nextContinuationToken?: string;

	// ✅ Separate “loop health” from “chat activity”
	private lastPollSuccessTime = Date.now();
	private consecutiveEmptyPolls = 0;
	private tokenStallSince = Date.now();

	private lastMessageTime = Date.now();
	private bootTime = Date.now(); // The "Time Barrier"

	constructor(private state: DurableObjectState, private env: Env) {
		const r = Router<Request, IHTTPMethods>();
		this.router = r;
		r.post('/init', this.init);

		// ✅ Accept both /ws and /ws/:videoId (backward compatible)
		r.get('/ws/:videoId', this.handleWebsocket);
		r.get('/ws', this.handleWebsocket);

		r.all('*', () => new Response('Not found', { status: 404 }));

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
			try {
				socket.close();
			} catch (e) {}
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
			this.bootTime = Date.now();

			// ✅ Capture videoId from init body so auto-heal can work even if WS path is /ws
			let data: (VideoData & { videoId?: string }) | undefined;
			try {
				data = await req.json<any>();
			} catch (e) {
				// ignore
			}
			if (data?.videoId) this.videoId = data.videoId;

			if (this.initialized) {
				this.lastMessageTime = Date.now();
				this.lastPollSuccessTime = Date.now();
				this.consecutiveEmptyPolls = 0;

				try {
					const continuation = traverseJSON(data?.initialData, (value) => {
						if (value.title === 'Live chat') return value.continuation as Continuation;
					});
					if (continuation) {
						const token = getContinuationToken(continuation);
						if (token) {
							this.nextContinuationToken = token;
							this.tokenStallSince = Date.now();
						}
					}
				} catch (e) {}
				return new Response();
			}

			if (!data) return new Response('Bad init body', { status: 400 });

			this.initialized = true;

			this.apiKey = data.apiKey;
			this.clientVersion = data.clientVersion;
			this.visitorData = data.visitorData;
			this.initialData = data.initialData;

			this.lastMessageTime = Date.now();
			this.lastPollSuccessTime = Date.now();
			this.consecutiveEmptyPolls = 0;

			this.channelId =
				traverseJSON(this.initialData, (value, key) => {
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
			this.tokenStallSince = Date.now();

			if (!this.isLoopRunning) {
				this.fetchChat();
			}

			return new Response();
		});
	};

	private trackMessageId(id: string): boolean {
		if (this.recentMessageIds.has(id)) return false;
		this.recentMessageIds.add(id);
		if (this.recentMessageIds.size > 50) {
			const first = this.recentMessageIds.values().next().value;
			this.recentMessageIds.delete(first);
		}
		return true;
	}

	private async forceRefreshSession(): Promise<boolean> {
		if (!this.videoId) {
			this.broadcast({ debug: true, message: '⚠️ [AUTO-HEAL] Missing videoId in Durable Object.' });
			return false;
		}
		this.bootTime = Date.now();
		this.broadcast({ debug: true, message: '♻️ [AUTO-HEAL] Refreshing token...' });

		try {
			const url = `https://www.youtube.com/live_chat?is_popout=1&v=${this.videoId}`;
			const response = await fetch(url, { headers: COMMON_HEADERS });
			const text = await response.text();

			let json;
			const match1 = text.match(/window\["ytInitialData"\]\s*=\s*({.+?});/);
			const match2 = text.match(/var\s+ytInitialData\s*=\s*({.+?});/);

			if (match1) json = JSON.parse(match1[1]);
			else if (match2) json = JSON.parse(match2[1]);

			if (json) {
				const continuation = traverseJSON(json, (value) => {
					if (value.title === 'Live chat') return value.continuation as Continuation;
				});
				if (continuation) {
					const token = getContinuationToken(continuation);
					if (token) {
						this.nextContinuationToken = token;
						this.lastMessageTime = Date.now();
						this.lastPollSuccessTime = Date.now();
						this.consecutiveEmptyPolls = 0;
						this.tokenStallSince = Date.now();
						return true;
					}
				}
			}
		} catch (e) {}

		this.broadcast({ debug: true, message: '⚠️ [AUTO-HEAL] Token refresh failed.' });
		return false;
	}

	private async fetchChat() {
		this.isLoopRunning = true;
		let currentInterval = BASE_CHAT_INTERVAL;

		// ✅ Deadman should be based on polling health / token stall, not “messages arrived”
		const now = Date.now();
		const pollSilentMs = now - this.lastPollSuccessTime;
		const tokenStalledMs = now - this.tokenStallSince;

		if (pollSilentMs > 30000 || tokenStalledMs > 30000 || this.consecutiveEmptyPolls >= 15) {
			const recovered = await this.forceRefreshSession();
			if (!recovered) {
				setTimeout(() => this.fetchChat(), 5000);
				return;
			}
		}

		const tokenToUse = this.nextContinuationToken;
		if (!tokenToUse) {
			setTimeout(() => this.fetchChat(), 5000);
			return;
		}

		let timeoutId: any;

		try {
			const controller = new AbortController();

			const payload = {
				context: {
					client: {
						clientName: 'WEB',
						clientVersion: this.clientVersion,
						hl: 'en',
						gl: 'US',
						visitorData: this.visitorData,
						userAgent: COMMON_HEADERS['User-Agent'],
						osName: 'Windows',
						osVersion: '10.0',
						platform: 'DESKTOP',
					},
				},
				continuation: tokenToUse,
				currentPlayerState: { playerOffsetMs: '0' },
			};

			const fetchDataTask = async () => {
				const res = await fetch(
					`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}`,
					{
						method: 'POST',
						headers: COMMON_HEADERS,
						body: JSON.stringify(payload),
						redirect: 'manual',
						signal: controller.signal,
					}
				);
				if (!res.ok) throw new Error(`Status ${res.status}`);
				return await res.json<any>();
			};

			const timeoutPromise = new Promise<any>((_, reject) => {
				timeoutId = setTimeout(() => {
					controller.abort();
					reject(new Error('ForceTimeout'));
				}, 10000);
			});

			const data = await Promise.race([fetchDataTask(), timeoutPromise]);

			// ✅ This proves the loop is alive even if no chat messages
			this.lastPollSuccessTime = Date.now();

			let actions: any[] = [];

			if (data.continuationContents?.liveChatContinuation?.actions) {
				actions.push(...data.continuationContents.liveChatContinuation.actions);
			}
			if (data.onResponseReceivedEndpoints) {
				for (const endpoint of data.onResponseReceivedEndpoints) {
					const endpointActions = endpoint.appendContinuationItemsAction?.continuationItems;
					if (endpointActions) actions.push(...endpointActions);
					const reloadActions = endpoint.reloadContinuationItemsCommand?.continuationItems;
					if (reloadActions) actions.push(...reloadActions);
				}
			}

			if (actions.length > 0) {
				this.lastMessageTime = Date.now();
				this.consecutiveEmptyPolls = 0;
			} else {
				this.consecutiveEmptyPolls++;
			}

			// ✅ Strong continuation selection + adaptive interval
			const { token: nextToken, timeoutMs, kind } = extractContinuation(data);
			if (nextToken) {
				if (nextToken !== this.nextContinuationToken) this.tokenStallSince = Date.now();
				this.nextContinuationToken = nextToken;
				currentInterval = Math.max(1000, Math.min(10000, timeoutMs ?? BASE_CHAT_INTERVAL));

				// optional debug (comment out if too noisy)
				// this.broadcast({ debug: true, message: `🔁 [CONT] kind=${kind} interval=${currentInterval}ms empty=${this.consecutiveEmptyPolls}` });
			} else {
				// If we cannot find a continuation at all, treat as “stalled”
				this.tokenStallSince = Date.now() - 60000;
				this.broadcast({ debug: true, message: '⚠️ [CONT] No continuation found in response.' });
			}

			for (const action of actions) {
				let msgTimestamp = 0;
				try {
					const renderer =
						action.liveChatTextMessageRenderer ||
						action.liveChatPaidMessageRenderer ||
						action.liveChatMembershipItemRenderer ||
						action.liveChatPaidStickerRenderer;
					if (renderer && renderer.timestampUsec) {
						msgTimestamp = parseInt(renderer.timestampUsec) / 1000;
					}
				} catch (e) {}

				if (msgTimestamp > 0 && msgTimestamp < this.bootTime - 5000) {
					continue;
				}

				const id = this.getId(action);
				if (id) {
					if (!this.trackMessageId(id)) continue;
				}
				this.broadcast(action);
			}
		} catch (e: any) {
			currentInterval = 5000;
			this.broadcast({ debug: true, message: `⚠️ [FETCH] ${e?.message || String(e)}` });
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			setTimeout(() => this.fetchChat(), currentInterval);
		}
	}

	private getId(data: LiveChatAction) {
		try {
			const cleanData = { ...data };
			delete (cleanData as any).clickTrackingParams;
			const actionType = Object.keys(cleanData)[0] as keyof LiveChatAction;
			const action = (cleanData as any)[actionType]?.item;
			if (!action) return undefined;
			const rendererType = Object.keys(action)[0] as keyof ChatItemRenderer;
			const renderer = action[rendererType] as { id?: string };
			return renderer?.id;
		} catch (e) {
			return undefined;
		}
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

		// ✅ With /ws/:videoId, this sets properly
		const parts = url.pathname.split('/');
		const possibleId = parts[parts.length - 1];
		if (possibleId && possibleId !== 'ws') this.videoId = possibleId;

		const adapterType = url.searchParams.get('adapter') ?? 'json';
		const pair = new WebSocketPair();
		const ws = pair[1];
		ws.accept();

		const adapter = this.makeAdapter(adapterType);
		adapter.sockets.add(ws);

		ws.send(JSON.stringify({ debug: true, message: 'Connected. Listening for chat...' }));

		ws.addEventListener('close', () => {
			adapter.sockets.delete(ws);
			if (adapter.sockets.size === 0) this.adapters.delete(adapterType);
		});

		return new Response(null, { status: 101, webSocket: pair[0] });
	};

	async fetch(req: Request): Promise<Response> {
		return this.router.handle(req);
	}
}

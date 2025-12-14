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
	private initialData!: VideoData['initialData'];
	private apiKey!: string;
	private clientVersion!: string;
	private visitorData!: string;
	private seenMessages = new Map<string, number>();

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
				try { socket.send(pingData); } catch (e) {}
			}
		}
	}

	private broadcast(data: any) {
		for (const adapter of this.adapters.values()) {
			if (data.debug) {
				for (const socket of adapter.sockets) {
					try { socket.send(JSON.stringify(data)); } catch (e) {}
				}
				continue;
			}
			
			const transformed = adapter.transform(data);
			if (!transformed) continue;
			for (const socket of adapter.sockets) {
				try { socket.send(transformed); } catch (e) {}
			}
		}
	}

	private initialized = false;
	private init: Handler = (req) => {
		return this.state.blockConcurrencyWhile(async () => {
			if (this.initialized) return new Response();
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

			this.fetchChat(token);
			setInterval(() => this.clearSeenMessages(), 60 * 1000);
			return new Response();
		});
	};

	private nextContinuationToken?: string;
	private async clearSeenMessages() {
		const cutoff = Date.now() - 1000 * 60;
		for (const [id, timestamp] of this.seenMessages.entries()) {
			if (timestamp < cutoff) this.seenMessages.delete(id);
		}
	}

	private async fetchChat(continuationToken: string) {
		let nextToken = continuationToken;
		let currentInterval = BASE_CHAT_INTERVAL;

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
				continuation: continuationToken,
				currentPlayerState: { playerOffsetMs: "0" }
			};

			// --- THE FIX: Combine Fetch AND JSON Download into one task ---
			// This ensures the timer runs until we have the DATA, not just the connection.
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
				return await res.json<any>(); // <--- We wait for this INSIDE the race now
			};

			const timeoutPromise = new Promise<any>((_, reject) => 
				setTimeout(() => {
					controller.abort();
					reject(new Error("ForceTimeout"));
				}, 10000)
			);

			// Race the ENTIRE job (Connect + Download)
			const data = await Promise.race([fetchDataTask(), timeoutPromise]);

			// If we are here, we have the data.
			
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

			const foundToken = traverseJSON(data, (value, key) => {
				if (key === "continuation" && typeof value === "string") {
					return value;
				}
			});

			if (foundToken) {
				nextToken = foundToken;
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
			// Now this will catch the download freeze too!
			if (e.message === "ForceTimeout" || e.name === 'AbortError') {
				this.broadcast({ debug: true, message: "⚠️ [ANTI-FREEZE] Download hung. Resetting..." });
			}
			currentInterval = 5000;
		} finally {
			this.nextContinuationToken = nextToken;
			if (this.adapters.size > 0)
				setTimeout(() => this.fetchChat(nextToken), currentInterval);
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
		const adapterType = url.searchParams.get('adapter') ?? 'json';
		const pair = new WebSocketPair();
		const ws = pair[1];
		ws.accept();
		const adapter = this.makeAdapter(adapterType);
		adapter.sockets.add(ws);
		
		ws.send(JSON.stringify({ debug: true, message: "Connected. Listening for chat..." }));
		if (this.nextContinuationToken) this.fetchChat(this.nextContinuationToken);

		ws.addEventListener('close', () => {
			adapter.sockets.delete(ws);
			if (adapter.sockets.size === 0) this.adapters.delete(adapterType);
		});
		return new Response(null, { status: 101, webSocket: pair[0] });
	};

	async fetch(req: Request): Promise<Response> { return this.router.handle(req); }
}

import { IHTTPMethods, Router } from 'itty-router';
import { Env } from '.';
import {
	ChatItemRenderer,
	Continuation,
	LiveChatAction,
} from '@util/types';
import { traverseJSON } from '@util/util';
import { getContinuationToken, VideoData } from '@util/youtube';
import { MessageAdapter } from './adapters';
import { JSONMessageAdapter } from './adapters/json';
import { IRCMessageAdapter } from './adapters/irc';
import { RawMessageAdapter } from './adapters/raw';
import { TruffleMessageAdapter } from './adapters/truffle';
import { SubathonMessageAdapter } from './adapters/subathon';

const adapterMap: Record<
	string,
	(env: Env, channelId: string) => MessageAdapter
> = {
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

const chatInterval = 1000;

export class YoutubeChatV3 implements DurableObject {
	private router: Router<Request, IHTTPMethods>;
	private channelId!: string;
	private initialData!: VideoData['initialData'];
	private config!: VideoData['config'];
	private seenMessages = new Map<string, number>();

	constructor(private state: DurableObjectState, private env: Env) {
		const r = Router<Request, IHTTPMethods>();
		this.router = r;
		r.post('/init', this.init);
		r.get('/ws', this.handleWebsocket);
		r.all('*', () => new Response('Not found', { status: 404 }));
	}

	// Helper to send logs to the client
	private logToClient(message: string) {
		const payload = JSON.stringify({ debug: true, message: message });
		for (const adapter of this.adapters.values()) {
			for (const socket of adapter.sockets) {
				try { socket.send(payload); } catch (e) {}
			}
		}
	}

	private broadcast(data: LiveChatAction) {
		for (const adapter of this.adapters.values()) {
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
			this.config = data.config;
			this.initialData = data.initialData;
			
			this.channelId = traverseJSON(this.initialData, (value, key) => {
				if (key === 'channelNavigationEndpoint') {
					return value.browseEndpoint?.browseId;
				}
			}) || 'UNKNOWN';

			const continuation = traverseJSON(data.initialData, (value) => {
				if (value.title === 'Live chat') {
					return value.continuation as Continuation;
				}
			});

			if (!continuation) {
				this.initialized = false;
				return new Response('Failed to load chat - No continuation found', { status: 404 });
			}

			const token = getContinuationToken(continuation);
			if (!token) {
				this.initialized = false;
				return new Response('Failed to load chat - No token found', { status: 404 });
			}

			this.fetchChat(token);
			setInterval(() => this.clearSeenMessages(), 60 * 1000);

			return new Response();
		});
	};

	private nextContinuationToken?: string;

	private async clearSeenMessages() {
		const cutoff = Date.now() - 1000 * 60;
		for (const message of this.seenMessages.entries()) {
			const [id, timestamp] = message;
			if (timestamp < cutoff) {
				this.seenMessages.delete(id);
			}
		}
	}

	private async fetchChat(continuationToken: string) {
		let nextToken = continuationToken;
		try {
			// LOGGING: Let's see if the config is actually loaded
			if (!this.config?.INNERTUBE_CONTEXT) {
				this.logToClient("[ERROR] INNERTUBE_CONTEXT is missing! The scraper might have failed.");
				return;
			}

			const headers = {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Content-Type': 'application/json',
			};

			// We revert to the SCRAPED context, but we add the critical "isDocumentHidden" flag.
			const payload = {
				context: this.config.INNERTUBE_CONTEXT,
				continuation: continuationToken,
				currentPlayerState: { playerOffsetMs: "0" },
				webClientInfo: { isDocumentHidden: false } // <--- THE MISSING KEY?
			};

			const res = await fetch(
				`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.config.INNERTUBE_API_KEY}`,
				{ method: 'POST', headers: headers, body: JSON.stringify(payload) }
			);

			if (!res.ok) {
				const txt = await res.text();
				this.logToClient(`[FETCH ERROR] ${res.status}: ${txt.slice(0, 100)}`);
				throw new Error(`YouTube API Error: ${res.status}`);
			} else {
				// If 200 OK, we are good.
			}

			const data = await res.json<any>();
			
			// LOGGING: Tell us what keys we got, so we know where the data is.
			// this.logToClient(`[DATA KEYS] ${Object.keys(data).join(", ")}`);
			
			let actions: any[] = [];
			
			// Strategy A: Standard
			if (data.continuationContents?.liveChatContinuation?.actions) {
				actions.push(...data.continuationContents.liveChatContinuation.actions);
			}
			
			// Strategy B: Framework Updates (New)
			if (data.frameworkUpdates?.entityBatchUpdate?.mutations) {
				// this.logToClient(`[PARSER] Found ${data.frameworkUpdates.entityBatchUpdate.mutations.length} mutations`);
				// Note: Real chat actions usually aren't here, but status updates are.
			}

			// Strategy C: Response Endpoints (Lofi Girl)
			if (data.onResponseReceivedEndpoints) {
				for (const endpoint of data.onResponseReceivedEndpoints) {
					const endpointActions = endpoint.appendContinuationItemsAction?.continuationItems;
					if (endpointActions) {
						actions.push(...endpointActions);
					}
					const reloadActions = endpoint.reloadContinuationItemsCommand?.continuationItems;
					if (reloadActions) {
						actions.push(...reloadActions);
					}
				}
			}

			if (actions.length > 0) {
				this.logToClient(`[SUCCESS] Found ${actions.length} chat messages!`);
			}

			let nextContinuation = data.continuationContents?.liveChatContinuation?.continuations?.[0];
			if (!nextContinuation && data.continuationContents?.liveChatContinuation) {
				 nextContinuation = data.continuationContents.liveChatContinuation.continuations?.[0];
			}

			nextToken = (nextContinuation ? getContinuationToken(nextContinuation) : undefined) ?? continuationToken;

			for (const action of actions) {
				const id = this.getId(action);
				if (id) {
					if (this.seenMessages.has(id)) continue;
					this.seenMessages.set(id, Date.now());
				}
				this.broadcast(action);
			}
		} catch (e: any) {
			this.logToClient(`[CRITICAL ERROR] ${e.message}`);
		} finally {
			this.nextContinuationToken = nextToken;
			if (this.adapters.size > 0)
				setTimeout(() => this.fetchChat(nextToken), chatInterval);
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
		if (req.headers.get('Upgrade') !== 'websocket')
			return new Response('Expected a websocket', { status: 400 });

		const url = new URL(req.url);
		const adapterType = url.searchParams.get('adapter') ?? 'json';

		const pair = new WebSocketPair();
		const ws = pair[1];
		ws.accept();

		const wsResponse = new Response(null, { status: 101, webSocket: pair[0] });

		const adapter = this.makeAdapter(adapterType);
		adapter.sockets.add(ws);
		
		ws.send(JSON.stringify({
			debug: true,
			message: "DEBUG: Connected! Using SCRAPED context with isDocumentHidden:false"
		}));

		if (this.nextContinuationToken) this.fetchChat(this.nextContinuationToken);

		ws.addEventListener('close', () => {
			adapter.sockets.delete(ws);
			if (adapter.sockets.size === 0) this.adapters.delete(adapterType);
		});

		return wsResponse;
	};

	async fetch(req: Request): Promise<Response> {
		return this.router.handle(req);
	}
}

import { Err, err, Ok, ok } from 'neverthrow';
import {
	Continuation,
	isTextRun,
	Json,
	JsonObject,
	Result,
	YTString,
} from './types';

// Standard headers
export const COMMON_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
};

export type VideoData = {
	initialData: Json;
	apiKey: string;
	clientVersion: string;
	visitorData: string;
};

export async function getVideoData(
	urls: string[]
): Promise<Ok<VideoData, unknown> | Err<unknown, [string, number]>> {
	let response: Response | undefined;
	
	for (const url of urls) {
		try {
			response = await fetch(url, { headers: COMMON_HEADERS });
			if (response.ok) break;
		} catch (e) {
			console.error(`Failed to fetch ${url}`, e);
		}
	}

	if (!response || response.status === 404)
		return err(['Stream not found', 404]);
	
	if (!response.ok)
		return err(['Failed to fetch stream: ' + response.statusText, response.status]);

	const text = await response.text();

	// 1. API KEY
	const apiKeyMatch = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(text);
	if (!apiKeyMatch) return err(['Scraper: Missing API Key', 500]);
	const apiKey = apiKeyMatch[1];

	// 2. CLIENT VERSION
	const versionMatch = /"clientVersion"\s*:\s*"([^"]+)"/.exec(text);
	if (!versionMatch) return err(['Scraper: Missing Client Version', 500]);
	const clientVersion = versionMatch[1];

	// 3. VISITOR DATA
	const visitorMatch = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(text);
	const visitorData = visitorMatch ? visitorMatch[1] : "";

	// 4. INITIAL DATA
	const initialData = getMatch(
		text,
		/(?:var\s+ytInitialData|window\[['"]ytInitialData['"]\])\s*=\s*({[\s\S]+?});/
	);
	
	if (initialData.isErr()) {
		const fallback = getMatch(text, /ytInitialData\s*=\s*({[\s\S]+?});/);
		if (fallback.isErr()) return initialData;
		return ok({ initialData: fallback.value, apiKey, clientVersion, visitorData });
	}

	return ok({ initialData: initialData.value, apiKey, clientVersion, visitorData });
}

function getMatch<T extends Json = Json>(
	html: string,
	pattern: RegExp
): Result<T, [string, number]> {
	const match = pattern.exec(html);
	if (!match?.[1]) return err(['Failed to find video data pattern', 404]);
	try {
		return ok(JSON.parse(match[1]));
	} catch {
		return err(['Failed to parse video data JSON', 500]);
	}
}

export function getContinuationToken(continuation: Continuation) {
	const key = Object.keys(continuation)[0] as keyof Continuation;
	return continuation[key]?.continuation;
}

export function parseYTString(string?: YTString): string {
	if (!string) return '';
	if (string.simpleText) return string.simpleText;
	if (string.runs)
		return string.runs
			.map((run) => {
				if (isTextRun(run)) {
					return run.text;
				} else {
					if (run.emoji.isCustomEmoji) {
						return ` ${
							run.emoji.image.accessibility?.accessibilityData?.label ??
							run.emoji.searchTerms[1] ??
							run.emoji.searchTerms[0]
						} `;
					} else {
						return run.emoji.emojiId;
					}
				}
			})
			.join('')
			.trim();
	return '';
}

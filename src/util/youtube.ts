import { Err, err, Ok, ok } from 'neverthrow';
import { Continuation, isTextRun, Json, YTString } from './types';

export const COMMON_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+417;',
};

export type VideoData = {
	initialData: Json;
	apiKey: string;
	clientVersion: string;
	visitorData: string;
};

export async function getVideoData(
	inputs: string[]
): Promise<Ok<VideoData, unknown> | Err<unknown, [string, number]>> {
	let response: Response | undefined;
	
	for (const input of inputs) {
		let videoId = input;
		try {
			if (input.includes('youtube.com') || input.includes('youtu.be')) {
				const urlObj = new URL(input);
				videoId = urlObj.searchParams.get('v') || input;
			}
		} catch (e) {
			videoId = input;
		}

		const url = `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`;
		
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

	const apiKeyMatch = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(text);
	if (!apiKeyMatch) return err(['Scraper: Missing API Key', 500]);
	const apiKey = apiKeyMatch[1];

	const versionMatch = /"clientVersion"\s*:\s*"([^"]+)"/.exec(text);
	if (!versionMatch) return err(['Scraper: Missing Client Version', 500]);
	const clientVersion = versionMatch[1];

	const visitorMatch = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(text);
	const visitorData = visitorMatch ? visitorMatch[1] : "";

	let initialData = getMatch(text, /window\["ytInitialData"\]\s*=\s*({[\s\S]+?});/);
	if (initialData.isErr()) {
		initialData = getMatch(text, /(?:var\s+ytInitialData|window\[['"]ytInitialData['"]\])\s*=\s*({[\s\S]+?});/);
	}
	
	if (initialData.isErr()) return err(['Failed to parse ytInitialData from Popout', 500]);

	return ok({ initialData: initialData.value, apiKey, clientVersion, visitorData });
}

function getMatch<T extends Json = Json>(html: string, pattern: RegExp): Result<T, [string, number]> {
	const match = pattern.exec(html);
	if (!match?.[1]) return err(['Pattern not found', 404]);
	try { return ok(JSON.parse(match[1])); } catch { return err(['JSON Parse Error', 500]); }
}

export function getContinuationToken(continuation: Continuation) {
	const key = Object.keys(continuation)[0] as keyof Continuation;
	return continuation[key]?.continuation;
}

// --- RUTHLESS EMOTE FILTER ---
export function parseYTString(string?: YTString): string {
	if (!string) return '';
	if (string.simpleText) return string.simpleText;
	
	if (string.runs) {
		return string.runs
			.map((run) => {
				// 1. Text? Keep it.
				if (isTextRun(run)) {
					return run.text;
				} 
				
				// 2. Emoji? Check STRICT conditions.
				if (run.emoji) {
					// Condition A: It has a search term like ":smile:"
					if (run.emoji.searchTerms && run.emoji.searchTerms.length > 0) {
						return run.emoji.searchTerms[0];
					}
					
					// Condition B: It has a shortcut like ":)"
					// Only accept if it looks like a standard emoticon, not an ID
					if (run.emoji.shortcuts && run.emoji.shortcuts.length > 0) {
						const shortcut = run.emoji.shortcuts[0];
						// If shortcut is super long, it's likely an ID, so kill it.
						if (shortcut.length < 10) return shortcut;
					}

					// Condition C: It has a Label like "Smile"
					if (run.emoji.image?.accessibility?.accessibilityData?.label) {
						return `:${run.emoji.image.accessibility.accessibilityData.label}:`;
					}
					
					// If none of the above matches, DESTROY IT.
					// Do not return emojiId. Do not return image URL.
					return ''; 
				}
				
				return '';
			})
			.join(''); 
	}
	return '';
}

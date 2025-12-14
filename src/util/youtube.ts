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

		// Force Popout URL for cleaner data
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

// --- THE CLEANER ---
// This function decides what text gets sent to Resonite.
export function parseYTString(string?: YTString): string {
	if (!string) return '';
	if (string.simpleText) return string.simpleText;
	
	if (string.runs) {
		return string.runs
			.map((run) => {
				// 1. Regular Text? Keep it.
				if (isTextRun(run)) {
					return run.text;
				} 
				
				// 2. Emoji? Be RUTHLESS.
				if (run.emoji) {
					// Is it a standard emoji (like 😀) or a simple shortcut (like :) )?
					// We check if the shortcut is short (less than 6 chars).
					// If it's long, it's likely an internal ID -> DELETE IT.
					if (run.emoji.shortcuts && run.emoji.shortcuts.length > 0) {
						const shortcut = run.emoji.shortcuts[0];
						if (shortcut.length < 6) return shortcut; // Keep ":)"
					}

					// Is it a labeled emoji (like "Smile")?
					// Only keep it if it looks like a normal word, not a code.
					if (run.emoji.image?.accessibility?.accessibilityData?.label) {
						const label = run.emoji.image.accessibility.accessibilityData.label;
						if (label.length < 15) return `:${label}:`; // Keep ":Smile:"
					}
					
					// If it didn't pass the checks above, it's a "Poison Pill".
					// RETURN NOTHING. Delete it from existence.
					return ''; 
				}
				
				return '';
			})
			.join(''); 
	}
	return '';
}

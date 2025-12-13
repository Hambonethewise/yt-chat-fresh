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
		// --- CRASH PROOFING ---
		// We extract the ID whether the input is a URL or a raw ID
		let videoId = input;
		try {
			// If it looks like a URL, try to parse it
			if (input.includes('youtube.com') || input.includes('youtu.be')) {
				const urlObj = new URL(input);
				videoId = urlObj.searchParams.get('v') || input;
			}
		} catch (e) {
			// If it fails to parse as URL, assume it is already an ID
			videoId = input;
		}

		// Now force the Popout URL which is safer for scraping
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

	// 1. SURGICAL EXTRACTION
	const apiKeyMatch = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(text);
	if (!apiKeyMatch) return err(['Scraper: Missing API Key', 500]);
	const apiKey = apiKeyMatch[1];

	const versionMatch = /"clientVersion"\s*:\s*"([^"]+)"/.exec(text);
	if (!versionMatch) return err(['Scraper: Missing Client Version', 500]);
	const clientVersion = versionMatch[1];

	const visitorMatch = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(text);
	const visitorData = visitorMatch ? visitorMatch[1] : "";

	// 2. INITIAL DATA (Popout structure)
	let initialData = getMatch(text, /window\["ytInitialData"\]\s*=\s*({[\s\S]+?});/);
	if (initialData.isErr()) {
		// Fallback for standard structure
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

export function parseYTString(string?: YTString): string {
	if (!string) return '';
	if (string.simpleText) return string.simpleText;
	if (string.runs)
		return string.runs
			.map((run) => {
				if (isTextRun(run)) return run.text;
				return run.emoji.emojiId;
			})
			.join('')
			.trim();
	return '';
}

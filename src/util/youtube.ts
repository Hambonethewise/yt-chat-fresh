import { Err, err, Ok, ok } from 'neverthrow';
import {
	Continuation,
	isTextRun,
	Json,
	JsonObject,
	Result,
	YTString,
} from './types';

export const COMMON_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
};

export type VideoData = {
	initialData: Json;
	config: YTConfig;
};

export type YTConfig = {
	INNERTUBE_API_KEY: string;
	INNERTUBE_CONTEXT: Json;
} & JsonObject;

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

	// 1. Initial Data (Regex is fine here as it's usually one block)
	// But we use the robust extractor just in case
	let initialData: Result<Json, any> = extractJson(text, /var\s+ytInitialData\s*=\s*/);
	if (initialData.isErr()) {
		initialData = extractJson(text, /window\[['"]ytInitialData['"]\]\s*=\s*/);
	}

	// 2. Config (The Magnet Strategy with Brace Counting)
	// We scan the document for ALL occurrences of ytcfg.set(...)
	const configMap: any = {};
	const startPattern = /ytcfg\.set\s*\(\s*/g;
	let match;

	while ((match = startPattern.exec(text)) !== null) {
		// match.index is the start of "ytcfg.set("
		// We want to start parsing AFTER the opening parenthesis
		const startIdx = match.index + match[0].length;
		const extracted = extractBalancedJson(text, startIdx);
		
		if (extracted) {
			try {
				const parsed = JSON.parse(extracted);
				Object.assign(configMap, parsed);
			} catch (e) {
				// Skip invalid chunks
			}
		}
	}

	// 3. Validation
	if (!configMap.INNERTUBE_API_KEY) {
		// Fallback: Try to find specific key via regex if the parser missed it
		const manualKey = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(text);
		if (manualKey) configMap.INNERTUBE_API_KEY = manualKey[1];
		else return err(['Scraper failed: Missing API Key', 500]);
	}

	// If Context is missing, we try to construct a minimal one, but usually the map has it.
	if (!configMap.INNERTUBE_CONTEXT) {
		configMap.INNERTUBE_CONTEXT = {
			client: {
				hl: 'en',
				gl: 'US',
				clientName: 'WEB',
				clientVersion: '2.20230920.00.00',
				userAgent: COMMON_HEADERS['User-Agent'],
				osName: 'Windows',
				osVersion: '10.0',
				platform: 'DESKTOP'
			}
		};
	}

	// If initialData failed, return error
	if (initialData.isErr()) {
		// Try one last desperate regex for initialData
		const regexMatch = /ytInitialData\s*=\s*({.+?});/.exec(text);
		if (regexMatch) {
			try {
				return ok({ initialData: JSON.parse(regexMatch[1]), config: configMap });
			} catch (e) {}
		}
		return err(['Failed to parse video data', 500]);
	}

	return ok({ initialData: initialData.value, config: configMap });
}

// --- THE BRACE COUNTER ---
// This ensures we capture nested JSON correctly
function extractBalancedJson(text: string, startIndex: number): string | null {
	let braceCount = 0;
	let inString = false;
	let isEscaped = false;
	let foundStart = false;
	let endIndex = -1;

	for (let i = startIndex; i < text.length; i++) {
		const char = text[i];

		if (!foundStart) {
			// Skip whitespace until we find the first '{'
			if (/\s/.test(char)) continue;
			if (char === '{') {
				foundStart = true;
				braceCount = 1;
			} else {
				// Not a JSON object start
				return null;
			}
			continue;
		}

		if (isEscaped) {
			isEscaped = false;
			continue;
		}

		if (char === '\\') {
			isEscaped = true;
			continue;
		}

		if (char === '"') {
			inString = !inString;
			continue;
		}

		if (!inString) {
			if (char === '{') braceCount++;
			else if (char === '}') {
				braceCount--;
				if (braceCount === 0) {
					endIndex = i + 1;
					break;
				}
			}
		}
	}

	if (endIndex !== -1) {
		return text.substring(startIndex, endIndex); // Note: We might need to adjust start index logic if we skipped chars
	}
	// Correction: The loop above correctly finds the bounds starting from the first {
	// But we need to return the substring from the first { to the last }
	// Let's rely on a slightly simpler logic since we control the call site:
	// The call site passes the index immediately after "ytcfg.set(".
	// We just need to find the full object.
	
	// Simpler implementation for the call site usage:
	return extractJsonString(text, startIndex);
}

function extractJsonString(text: string, startSearch: number): string | null {
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = startSearch; i < text.length; i++) {
		const c = text[i];
		if (!inString && (c === ' ' || c === '\n' || c === '\r' || c === '\t') && start === -1) continue;
		
		if (start === -1) {
			if (c === '{') {
				start = i;
				depth = 1;
			} else {
				return null; // Not an object
			}
		} else {
			if (c === '\\' && !escaped) { escaped = true; continue; }
			if (c === '"' && !escaped) inString = !inString;
			if (!inString && !escaped) {
				if (c === '{') depth++;
				if (c === '}') {
					depth--;
					if (depth === 0) return text.substring(start, i + 1);
				}
			}
			escaped = false;
		}
	}
	return null;
}

function extractJson<T extends Json = Json>(html: string, pattern: RegExp): Result<T, [string, number]> {
	const match = pattern.exec(html);
	if (!match) return err(['Pattern not found', 404]);
	const jsonStr = extractJsonString(html, match.index! + match[0].length);
	if (!jsonStr) return err(['Failed to extract JSON', 500]);
	try {
		return ok(JSON.parse(jsonStr));
	} catch {
		return err(['JSON Parse Error', 500]);
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

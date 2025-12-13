import { ok } from 'neverthrow';
import { Handler } from '@util/types';
import { notFound } from '@util/util';
import { getVideoData } from '@util/youtube';
import { createChatObject } from '../YoutubeChat';

export const getStream: Handler<{ id: string }> = async (request, env) => {
	// Validate ID format (11 characters)
	if (!request.params.id || !/^[A-Za-z0-9_-]{11}$/.test(request.params.id)) {
		return notFound;
	}

	const url = `https://www.youtube.com/watch?v=${request.params.id}`;

	// Fetch the initial data using our robust scraper
	const videoData = await getVideoData([url]);
	
	if (videoData.isErr()) {
		const [message, status] = videoData.error;
		return new Response(message, { status });
	}

	// Hand off to the Durable Object to start the WebSocket loop
	const res = await createChatObject(
		request.params.id,
		videoData.value,
		request,
		env
	);
	
	return ok(res);
};

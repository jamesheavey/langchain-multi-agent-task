import { makeChatbotGraph } from '$lib/chatbot/Chatbot';
import { AIMessage, HumanMessage, AIMessageChunk } from '@langchain/core/messages';
import { z } from 'zod';

const messagesSchema = z.object({
	messages: z
		.array(
			z
				.object({
					type: z.enum(['human', 'ai']),
					content: z.string()
				})
				.transform((message) => {
					if (message.type === 'human') {
						return new HumanMessage({
							content: message.content
						});
					} else {
						return new AIMessage({
							content: message.content
						});
					}
				})
		)
		.refine((messages) => {
			// Check if there are any messages
			if (messages.length === 0) {
				return false;
			}

			// Check if the last message is a human message
			if (messages.at(-1) instanceof HumanMessage) {
				return true;
			}
		})
});

export const POST = async ({ request }) => {
	const data = await request.json();
	const { messages } = messagesSchema.parse(data);
	const graph = await makeChatbotGraph();

	// Keep thread_id and add user
	const threadId = Math.random().toString(36).substring(7);
	const config = {
		configurable: {
			thread_id: threadId,
		},
		recursionLimit: 20
	};

	// Stream events with comprehensive event handling
	const stream = new ReadableStream({
		async start(controller) {
			const events = graph.streamEvents(
				{ messages },
				{ ...config, version: 'v2' }
			);

			for await (const { event, data, tags } of events) {
				
				if (event === 'on_chat_model_stream' && tags?.includes('Supervisor')) {
					console.log(JSON.stringify({ event, data, tags }, null, 2));
					controller.enqueue(
						JSON.stringify({
							type: 'token',
							data: data.chunk.content
						})
					);
				}
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: { 'Content-Type': 'application/json' }
	});
};

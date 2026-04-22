import type { SSEEvent } from "../../src/lib/relay/opencode-events.js";

/** Create a typed SSE event for testing. */
export function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): SSEEvent {
	return { type, properties } as SSEEvent;
}

/** Create an intentionally unknown SSE event for testing. */
export function makeUnknownSSEEvent(
	type: string,
	properties: Record<string, unknown> = {},
): SSEEvent {
	return { type, properties } as SSEEvent;
}

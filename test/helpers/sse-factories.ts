import type { OpenCodeEvent } from "../../src/lib/types.js";

/** Create a typed SSE event for testing. */
export function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

/** Create an intentionally unknown SSE event for testing. */
export function makeUnknownSSEEvent(
	type: string,
	properties: Record<string, unknown> = {},
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

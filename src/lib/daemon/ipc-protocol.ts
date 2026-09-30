import type { IPCResponse } from "../types.js";

/** Serialize a response to a JSON line. */
export function serializeResponse(response: IPCResponse): string {
	return `${JSON.stringify(response)}\n`;
}

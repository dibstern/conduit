import type { CursorSdkPort } from "./sdk-port.js";
import { createRealCursorSdkPort } from "./sdk-real.js";
import { teeCursorSdkPort } from "./sdk-trace.js";
import { createTraceCursorSdkPort } from "./sdk-trace-player.js";

export function createCursorSdkPort(): CursorSdkPort {
	const tracePath = process.env["CONDUIT_CURSOR_SDK_TRACE"];
	return teeCursorSdkPort(
		tracePath ? createTraceCursorSdkPort(tracePath) : createRealCursorSdkPort(),
		process.env["CONDUIT_CURSOR_SDK_CAPTURE"],
	);
}

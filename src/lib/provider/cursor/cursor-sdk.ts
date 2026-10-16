import type { CursorSdkPort } from "./sdk-port.js";
import { createRealCursorSdkPort } from "./sdk-real.js";
import { teeCursorSdkPort } from "./sdk-trace.js";
import { createTraceCursorSdkPort } from "./sdk-trace-player.js";

export function createCursorSdkPort(): CursorSdkPort {
	const tracePath = process.env["CONDUIT_CURSOR_SDK_TRACE"];
	return teeCursorSdkPort(
		tracePath
			? createTraceCursorSdkPort(
					tracePath,
					process.env["NODE_ENV"] === "test"
						? {
								closeDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_CLOSE_DELAY_MS"] ?? 0,
								),
								disposeDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_DISPOSE_DELAY_MS"] ?? 0,
								),
								deltaDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_DELTA_DELAY_MS"] ?? 0,
								),
								waitDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_WAIT_DELAY_MS"] ?? 0,
								),
								cancelTerminalDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_CANCEL_TERMINAL_DELAY_MS"] ??
										0,
								),
								cancelNeverSettles:
									process.env["CONDUIT_TEST_CURSOR_CANCEL_NEVER_SETTLES"] ===
									"1",
								...(process.env["CONDUIT_TEST_CURSOR_SEND_GATE"]
									? { sendGate: process.env["CONDUIT_TEST_CURSOR_SEND_GATE"] }
									: {}),
								...(process.env["CONDUIT_TEST_CURSOR_STREAM_GATE"]
									? {
											streamGate:
												process.env["CONDUIT_TEST_CURSOR_STREAM_GATE"],
										}
									: {}),
							}
						: {},
				)
			: createRealCursorSdkPort(),
		process.env["CONDUIT_CURSOR_SDK_CAPTURE"],
	);
}

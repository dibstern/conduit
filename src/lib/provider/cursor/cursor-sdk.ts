import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type { CursorSdkPort } from "./sdk-port.js";
import { createRealCursorSdkPort } from "./sdk-real.js";
import { teeCursorSdkPort } from "./sdk-trace.js";
import { createTraceCursorSdkPort } from "./sdk-trace-player.js";

export const cursorCredentialStorePath = (
	id: string,
	configDir = DEFAULT_CONFIG_DIR,
) =>
	join(
		configDir,
		"cursor",
		"accounts",
		createHash("sha256").update(id).digest("hex"),
		"auth.json",
	);

export function createCursorSdkPort(account?: {
	readonly id: string;
	readonly configDir?: string;
}): CursorSdkPort {
	const tracePath = process.env["CONDUIT_CURSOR_SDK_TRACE"];
	const authStatePath = process.env["CONDUIT_TEST_CURSOR_AUTH_STATE"];
	return teeCursorSdkPort(
		tracePath
			? createTraceCursorSdkPort(
					tracePath,
					process.env["NODE_ENV"] === "test"
						? {
								...(account ? { accountId: account.id } : {}),
								...(authStatePath ? { authStatePath } : {}),
								loginDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS"] ?? 0,
								),
								loginUrlDelayMs: Number(
									process.env["CONDUIT_TEST_CURSOR_LOGIN_URL_DELAY_MS"] ?? 0,
								),
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
			: createRealCursorSdkPort(
					account
						? cursorCredentialStorePath(account.id, account.configDir)
						: undefined,
				),
		process.env["CONDUIT_CURSOR_SDK_CAPTURE"],
	);
}

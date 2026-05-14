// ─── Terminal / PTY Handlers ─────────────────────────────────────────────────

import { Effect } from "effect";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import type { PayloadMap } from "./payloads.js";

export const handlePtyInput = (
	_clientId: string,
	payload: PayloadMap["pty_input"],
) =>
	Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;

		const { ptyId, data } = payload;
		if (ptyId && data) {
			yield* terminal.sendInput(ptyId, data);
		}
	});

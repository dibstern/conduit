// ─── Terminal / PTY Handlers ─────────────────────────────────────────────────

import { Effect } from "effect";
import { OpenCodeTerminalServiceTag } from "../effect/terminal-service.js";
import type { PayloadMap } from "./payloads.js";

export const handleTerminalCommand = (
	clientId: string,
	payload: PayloadMap["terminal_command"],
) =>
	Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;

		const { action } = payload;

		if (action === "create") {
			yield* terminal.create(clientId);
		} else if (action === "close" || action === "delete") {
			const ptyId = payload.ptyId ?? "";
			if (ptyId) {
				yield* terminal.close(ptyId);
			}
		} else if (action === "list") {
			yield* terminal.list(clientId);
		}
	});

export const handlePtyCreate = (
	clientId: string,
	_payload: PayloadMap["pty_create"],
) =>
	Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;
		yield* terminal.create(clientId);
	});

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

export const handlePtyResize = (
	clientId: string,
	payload: PayloadMap["pty_resize"],
) =>
	Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;

		const { ptyId } = payload;
		const cols = payload.cols ?? 80;
		const rows = payload.rows ?? 24;
		if (ptyId) {
			yield* terminal.resize(clientId, ptyId, rows, cols);
		}
	});

export const handlePtyClose = (
	_clientId: string,
	payload: PayloadMap["pty_close"],
) =>
	Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;

		const { ptyId } = payload;
		if (ptyId) {
			yield* terminal.close(ptyId);
		}
	});

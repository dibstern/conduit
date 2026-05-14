import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	type OpenCodeTerminalService,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { handlePtyInput } from "../../../src/lib/handlers/terminal.js";

const makeTerminalService = (
	overrides?: Partial<OpenCodeTerminalService>,
): OpenCodeTerminalService => ({
	create: vi.fn(() => Effect.void),
	list: vi.fn(() => Effect.succeed([])),
	replay: vi.fn(() => Effect.void),
	sendInput: vi.fn(() => Effect.void),
	close: vi.fn(() => Effect.void),
	resize: vi.fn(() => Effect.void),
	...overrides,
});

describe("terminal handlers with Effect-native terminal service", () => {
	it.effect(
		"sends PTY input through the terminal service without requiring the legacy PtyManager tag",
		() => {
			const terminal = makeTerminalService();
			const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

			return handlePtyInput("client-1", {
				ptyId: "pty-1",
				data: "ls\n",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(terminal.sendInput).toHaveBeenCalledWith("pty-1", "ls\n");
				}),
			);
		},
	);
});

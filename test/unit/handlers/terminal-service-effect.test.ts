import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	type OpenCodeTerminalService,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/effect/terminal-service.js";
import {
	handlePtyClose,
	handlePtyInput,
	handlePtyResize,
} from "../../../src/lib/handlers/terminal.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

const makeTerminalService = (
	overrides?: Partial<OpenCodeTerminalService>,
): OpenCodeTerminalService => ({
	create: vi.fn(() => Effect.void),
	list: vi.fn(() => Effect.void),
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

	it.effect(
		"closes PTYs through the terminal service without requiring the OpenCode API tag",
		() => {
			const terminal = makeTerminalService();
			const layer = Layer.succeed(OpenCodeTerminalServiceTag, terminal);

			return handlePtyClose("client-1", { ptyId: "pty-1" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(terminal.close).toHaveBeenCalledWith("pty-1");
				}),
			);
		},
	);

	it.effect(
		"resizes PTYs through the terminal service without requiring the OpenCode API tag",
		() => {
			const terminal = makeTerminalService();
			const ws = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const log = makeMockLogger();
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeTerminalServiceTag, terminal),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
			);

			return handlePtyResize("client-1", {
				ptyId: "pty-1",
				rows: 40,
				cols: 120,
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(terminal.resize).toHaveBeenCalledWith(
						"client-1",
						"pty-1",
						40,
						120,
					);
				}),
			);
		},
	);
});

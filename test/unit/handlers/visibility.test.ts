import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { expect } from "vitest";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getHiddenEntries,
	setHiddenEntriesForRelay,
} from "../../../src/lib/handlers/visibility.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

function makeLayer(configDir: string) {
	const ws = makeMockWebSocketHandler();
	const layer = Layer.mergeAll(
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(LoggerTag, makeMockLogger() as Logger),
		Layer.succeed(ConfigTag, makeMockConfig({ configDir })),
	);
	return { ws, layer };
}

describe("setHiddenEntriesForRelay", () => {
	it.effect(
		"persists provided lists to relay settings and broadcasts visibility_info",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
			const { ws, layer } = makeLayer(configDir);

			return Effect.gen(function* () {
				const result = yield* setHiddenEntriesForRelay({
					clientId: "c1",
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});

				const persisted = loadRelaySettings(configDir);
				expect(persisted.hiddenModels).toEqual(["a/b"]);
				expect(persisted.hiddenAgents).toEqual(["opencode/plan"]);
				expect(ws.broadcast).toHaveBeenCalledWith({
					type: "visibility_info",
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});
				expect(result).toEqual({
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("leaves the omitted list untouched", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
		saveRelaySettings({ hiddenAgents: ["claude/researcher"] }, configDir);
		const { ws, layer } = makeLayer(configDir);

		return Effect.gen(function* () {
			const result = yield* setHiddenEntriesForRelay({
				clientId: "c1",
				hiddenModels: ["x/y"],
			});

			const persisted = loadRelaySettings(configDir);
			expect(persisted.hiddenModels).toEqual(["x/y"]);
			expect(persisted.hiddenAgents).toEqual(["claude/researcher"]);
			expect(ws.broadcast).toHaveBeenCalledWith({
				type: "visibility_info",
				hiddenModels: ["x/y"],
				hiddenAgents: ["claude/researcher"],
			});
			expect(result).toEqual({
				hiddenModels: ["x/y"],
				hiddenAgents: ["claude/researcher"],
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"surfaces fs failures as a catchable typed failure, not a defect",
		() => {
			// configDir points at a FILE, so saveRelaySettings' mkdirSync throws.
			const base = mkdtempSync(join(tmpdir(), "conduit-visibility-fail-"));
			const notADir = join(base, "not-a-dir");
			writeFileSync(notADir, "occupied", "utf-8");
			const { ws, layer } = makeLayer(notADir);

			return Effect.gen(function* () {
				const exit = yield* Effect.exit(
					setHiddenEntriesForRelay({ clientId: "c1", hiddenModels: ["a/b"] }),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const failure = Exit.isFailure(exit)
					? Cause.failureOption(exit.cause) // Some only for a Fail, not a Die
					: Option.none();
				expect(Option.isSome(failure)).toBe(true);
				if (Option.isSome(failure)) {
					expect(failure.value._tag).toBe("RelaySettingsSaveError");
				}
				expect(ws.broadcast).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);
});

describe("getHiddenEntries", () => {
	it("returns empty arrays when nothing persisted", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-empty-"));
		expect(getHiddenEntries(configDir)).toEqual({
			hiddenModels: [],
			hiddenAgents: [],
		});
	});
});

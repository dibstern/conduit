import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, PubSub } from "effect";
import { expect } from "vitest";
import {
	loadGlobalSettings,
	saveGlobalSettings,
} from "../../../src/lib/daemon/global-settings.js";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
} from "../../../src/lib/domain/project-services/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/project-services/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/project-services/Services/session-overrides-state.js";
import {
	getHiddenEntries,
	setHiddenEntriesGlobally,
} from "../../../src/lib/handlers/visibility.js";
import type { Logger } from "../../../src/lib/logger.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

function makeLayer(configDir: string) {
	return Layer.mergeAll(
		ProjectSettingsLive,
		makeOverridesStateLive(),
		Layer.succeed(LoggerTag)(makeMockLogger() as Logger),
		Layer.succeed(ConfigTag)(makeMockConfig({ configDir })),
	);
}

/** What open project-settings subscribers would hear from here on. */
const published = Effect.flatMap(ProjectSettingsTag, ({ changes }) =>
	Effect.map(PubSub.subscribe(changes), (dequeue) =>
		Effect.map(PubSub.takeUpTo(dequeue, Number.POSITIVE_INFINITY), (taken) =>
			[...taken].map((change) => change.item),
		),
	),
);

describe("setHiddenEntriesGlobally", () => {
	it.effect(
		"persists provided lists to relay settings and publishes the visibility setting",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
			const layer = makeLayer(configDir);

			return Effect.gen(function* () {
				const takePublished = yield* published;
				const result = yield* setHiddenEntriesGlobally({
					clientId: "c1",
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});

				const persisted = loadGlobalSettings(configDir);
				expect(persisted.hiddenModels).toEqual(["a/b"]);
				expect(persisted.hiddenAgents).toEqual(["opencode/plan"]);
				expect(yield* takePublished).toEqual([
					{
						_tag: "visibility",
						hiddenModels: ["a/b"],
						hiddenAgents: ["opencode/plan"],
					},
				]);
				expect(result).toEqual({
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);

	it.effect("leaves the omitted list untouched", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
		saveGlobalSettings({ hiddenAgents: ["claude/researcher"] }, configDir);
		const layer = makeLayer(configDir);

		return Effect.gen(function* () {
			const takePublished = yield* published;
			const result = yield* setHiddenEntriesGlobally({
				clientId: "c1",
				hiddenModels: ["x/y"],
			});

			const persisted = loadGlobalSettings(configDir);
			expect(persisted.hiddenModels).toEqual(["x/y"]);
			expect(persisted.hiddenAgents).toEqual(["claude/researcher"]);
			expect(yield* takePublished).toEqual([
				{
					_tag: "visibility",
					hiddenModels: ["x/y"],
					hiddenAgents: ["claude/researcher"],
				},
			]);
			expect(result).toEqual({
				hiddenModels: ["x/y"],
				hiddenAgents: ["claude/researcher"],
			});
		}).pipe(Effect.provide(layer, { local: true }));
	});

	it.effect(
		"surfaces fs failures as a catchable typed failure, not a defect",
		() => {
			// configDir points at a FILE, so saveGlobalSettings' mkdirSync throws.
			const base = mkdtempSync(join(tmpdir(), "conduit-visibility-fail-"));
			const notADir = join(base, "not-a-dir");
			writeFileSync(notADir, "occupied", "utf-8");
			const layer = makeLayer(notADir);

			return Effect.gen(function* () {
				const takePublished = yield* published;
				const exit = yield* Effect.exit(
					setHiddenEntriesGlobally({ clientId: "c1", hiddenModels: ["a/b"] }),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const failure = Exit.isFailure(exit)
					? Cause.findErrorOption(exit.cause) // Some only for a Fail, not a Die
					: Option.none();
				expect(Option.isSome(failure)).toBe(true);
				if (Option.isSome(failure)) {
					expect(failure.value._tag).toBe("GlobalSettingsSaveError");
				}
				expect(yield* takePublished).toEqual([]);
			}).pipe(Effect.provide(layer, { local: true }));
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Cause,
	Chunk,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Queue,
} from "effect";
import { expect } from "vitest";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
} from "../../../src/lib/domain/relay/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
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
} from "../../helpers/mock-factories.js";

function makeLayer(configDir: string) {
	return Layer.mergeAll(
		ProjectSettingsLive,
		makeOverridesStateLive(),
		Layer.succeed(LoggerTag, makeMockLogger() as Logger),
		Layer.succeed(ConfigTag, makeMockConfig({ configDir })),
	);
}

/** What open project-settings subscribers would hear from here on. */
const published = Effect.flatMap(ProjectSettingsTag, ({ changes }) =>
	Effect.map(PubSub.subscribe(changes), (dequeue) =>
		Effect.map(Queue.takeAll(dequeue), (taken) =>
			Chunk.toArray(taken).map((change) => change.item),
		),
	),
);

describe("setHiddenEntriesForRelay", () => {
	it.scoped(
		"persists provided lists to relay settings and publishes the visibility setting",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
			const layer = makeLayer(configDir);

			return Effect.gen(function* () {
				const takePublished = yield* published;
				const result = yield* setHiddenEntriesForRelay({
					clientId: "c1",
					hiddenModels: ["a/b"],
					hiddenAgents: ["opencode/plan"],
				});

				const persisted = loadRelaySettings(configDir);
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
			}).pipe(Effect.provide(layer));
		},
	);

	it.scoped("leaves the omitted list untouched", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-visibility-"));
		saveRelaySettings({ hiddenAgents: ["claude/researcher"] }, configDir);
		const layer = makeLayer(configDir);

		return Effect.gen(function* () {
			const takePublished = yield* published;
			const result = yield* setHiddenEntriesForRelay({
				clientId: "c1",
				hiddenModels: ["x/y"],
			});

			const persisted = loadRelaySettings(configDir);
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
		}).pipe(Effect.provide(layer));
	});

	it.scoped(
		"surfaces fs failures as a catchable typed failure, not a defect",
		() => {
			// configDir points at a FILE, so saveRelaySettings' mkdirSync throws.
			const base = mkdtempSync(join(tmpdir(), "conduit-visibility-fail-"));
			const notADir = join(base, "not-a-dir");
			writeFileSync(notADir, "occupied", "utf-8");
			const layer = makeLayer(notADir);

			return Effect.gen(function* () {
				const takePublished = yield* published;
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
				expect(yield* takePublished).toEqual([]);
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

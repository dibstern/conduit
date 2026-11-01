// Failure modes: a variant the catalog no longer offers launches with stale or
// default params; the chosen params ride only an untyped provider-state key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCursorRunnerDriver } from "../../../../src/lib/provider/cursor/cursor-runner-driver.js";
import { createTraceCursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-trace-player.js";
import { cursorAccountResourcesFixture } from "../../../helpers/cursor-account-resources-fixture.js";

describe("Cursor prepared turn facts", () => {
	it.effect.each([
		{
			variant: "Fast",
			expected: {
				_tag: "Success",
				facts: {
					_tag: "Cursor",
					model: { _tag: "Resolved", params: [{ id: "fast", value: "true" }] },
				},
				providerState: {},
			},
		},
		{
			// The variant vanished between send and recovery.
			variant: "Vanished",
			expected: {
				_tag: "Failure",
				code: "model_parameters_unavailable",
			},
		},
	])("prepares the $variant choice", ({ variant, expected }) =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "cursor-turn-facts-"))),
				(path) =>
					Effect.sync(() => rmSync(path, { recursive: true, force: true })),
			);
			const driver = makeCursorRunnerDriver(
				cursorAccountResourcesFixture(
					createTraceCursorSdkPort(
						resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
					),
				),
				undefined,
				root,
			);
			const prepared = yield* Effect.result(
				driver.prepareTurnEffect({
					sessionId: "session",
					inputId: "input",
					runId: "run",
					prompt: "Say hi.",
					history: [],
					providerState: {},
					workspaceRoot: root,
					extraFolders: [],
					configDir: configuredClaudeConfigDir(root),
					folderSource: "account",
					model: { providerId: "cursor", modelId: "composer-2.5" },
					variant,
					account: {
						id: AccountIdSchema.make("cursor"),
						driver: "cursor",
						name: "Cursor",
						usageEligible: false,
					},
				}),
			);
			// The chosen params ride the typed facts, not an untyped provider-state key.
			expect(
				prepared._tag === "Success"
					? {
							_tag: prepared._tag,
							facts: prepared.success.input.facts,
							providerState: prepared.success.input.providerState,
						}
					: { _tag: prepared._tag, code: prepared.failure.code },
			).toEqual(expected);
		}),
	);
});

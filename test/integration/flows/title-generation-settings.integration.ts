// Settings can lose a saved choice on reload, retain it after reset, accept an
// unknown account/model/effort, overwrite unrelated settings, or fail to notify
// another project's subscriber. Generation itself uses captured Claude replay
// in claude-session-title.integration.ts; these RPC tests use the production
// discovery fallback catalog without inventing provider responses.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect } from "vitest";
import type { TitleGenerationSelection } from "../../../src/lib/contracts/title-generation.js";
import {
	type GlobalSettingTag,
	type ProjectSetting,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { syncGlobalSetting } from "../../../src/lib/domain/relay/Services/project-settings.js";
import { discoverCapabilitiesEffect } from "../../../src/lib/provider/claude/claude-runtime-discovery.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const selection: TitleGenerationSelection = {
	account: { _tag: "Id", id: "claude" },
	providerId: "claude",
	modelId: "sonnet",
	effort: "",
};

const withSettings = <A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-title-settings-"))),
		run,
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
	);

const makeProject = (
	root: string,
	slug: string,
	publishGlobalSetting: (tag: GlobalSettingTag) => Effect.Effect<void> = () =>
		Effect.void,
) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			makeTestHandlerLayer({
				config: makeMockConfig({
					configDir: root,
					projectDir: root,
					slug,
					publishGlobalSetting,
				}),
				orchestrationEngine: withDispatchEffect({
					dispatchEffect: () =>
						discoverCapabilitiesEffect(
							root,
							undefined,
							configuredClaudeConfigDir(root),
						),
				}),
			}),
		);
		const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
			Effect.provide(WsRpcServerLayer),
			Effect.provide(context),
		);
		return { client, context };
	});

describe("title generation settings through browser RPC", () => {
	it.effect(
		"persists globally, publishes to another project, reloads, and resets",
		() =>
			withSettings((root) =>
				Effect.gen(function* () {
					saveRelaySettings({ hiddenModels: ["claude/opus"] }, root);
					const other = yield* makeProject(root, "other-project");
					const origin = yield* makeProject(root, "origin-project", (tag) =>
						syncGlobalSetting(tag).pipe(Effect.provide(other.context)),
					);
					const catalog = yield* origin.client.GetModels({
						projectSlug: "origin-project",
						instanceId: "claude",
					});
					expect(
						catalog.providers.flatMap((provider) =>
							provider.models.map((model) => model.id),
						),
					).toContain("sonnet");
					const changes = yield* Queue.unbounded<ProjectSetting>();
					const ready = yield* Deferred.make<void>();
					yield* other.client
						.SubscribeProjectSettings({ projectSlug: "other-project" })
						.pipe(
							Stream.runForEach((envelope) => {
								if (envelope._tag === "synchronized")
									return Deferred.succeed(ready, undefined);
								return envelope._tag === "upsert" &&
									envelope.item._tag === "titleGeneration"
									? Queue.offer(changes, envelope.item)
									: Effect.void;
							}),
							Effect.forkScoped,
						);
					yield* Deferred.await(ready);
					expect(
						yield* origin.client.GetTitleGeneration({
							projectSlug: "origin-project",
						}),
					).toEqual({ projectSlug: "origin-project", selection: null });
					expect(
						yield* origin.client.SetTitleGeneration({
							projectSlug: "origin-project",
							selection,
						}),
					).toEqual({ projectSlug: "origin-project", selection });
					expect(yield* Queue.take(changes)).toEqual({
						_tag: "titleGeneration",
						selection,
					});
					const reloaded = yield* makeProject(root, "reloaded-project");
					expect(
						yield* reloaded.client.GetTitleGeneration({
							projectSlug: "reloaded-project",
						}),
					).toEqual({ projectSlug: "reloaded-project", selection });
					expect(loadRelaySettings(root)).toMatchObject({
						titleGeneration: selection,
						hiddenModels: ["claude/opus"],
					});
					yield* origin.client.SetTitleGeneration({
						projectSlug: "origin-project",
						selection: null,
					});
					expect(yield* Queue.take(changes)).toEqual({
						_tag: "titleGeneration",
						selection: null,
					});
					expect(
						yield* other.client.GetTitleGeneration({
							projectSlug: "other-project",
						}),
					).toEqual({ projectSlug: "other-project", selection: null });
					expect(
						JSON.parse(readFileSync(join(root, "settings.jsonc"), "utf8")),
					).toEqual({
						hiddenModels: ["claude/opus"],
					});
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			),
	);

	for (const [name, invalid] of [
		[
			"unknown account",
			{ ...selection, account: { _tag: "Id", id: "missing" } },
		],
		["unknown model", { ...selection, modelId: "missing-model" }],
		["unsupported effort", { ...selection, effort: "unsupported-effort" }],
		[
			"unsupported harness",
			{ ...selection, account: { _tag: "Id", id: "opencode" } },
		],
	] as const) {
		it.effect(`rejects ${name} without replacing the saved selection`, () =>
			withSettings((root) =>
				Effect.gen(function* () {
					const { client } = yield* makeProject(root, "project");
					yield* client.SetTitleGeneration({
						projectSlug: "project",
						selection,
					});
					const rejected = yield* client
						.SetTitleGeneration({ projectSlug: "project", selection: invalid })
						.pipe(Effect.result);
					expect(rejected._tag).toBe("Failure");
					expect(loadRelaySettings(root).titleGeneration).toEqual(selection);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			),
		);
	}
});

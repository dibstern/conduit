import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { makeProviderAdaptersLive } from "../../src/lib/domain/daemon/Layers/provider-adapters-layer.js";
import {
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	type ProjectRegistryState,
	ProjectRegistryTag,
} from "../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ProviderAdapters } from "../../src/lib/domain/daemon/Services/provider-adapters.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../src/lib/domain/daemon/Services/session-activity.js";
import { ConfigTag } from "../../src/lib/domain/relay/Services/services.js";
import {
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../src/lib/persistence/effect/live.js";
import type { ClaudeProviderInstanceDeps } from "../../src/lib/provider/claude/claude-provider-runtime.js";
import { CursorAccountResources } from "../../src/lib/provider/cursor/cursor-account-resources.js";
import { createCursorSdkPort } from "../../src/lib/provider/cursor/cursor-sdk.js";
import {
	makeOrchestrationRuntimeLayer,
	type OrchestrationRuntimeLayerOptions,
} from "../../src/lib/provider/orchestration-wiring.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { cursorAccountResourcesFixture } from "./cursor-account-resources-fixture.js";

export interface TestAdapterOptions {
	readonly configDir?: string;
	readonly workspaceRoot?: string;
	readonly projectId?: string;
	readonly claudeSdk?: Partial<NonNullable<ProjectRelayConfig["claudeSdk"]>>;
	readonly claudeQueryFactory?: ClaudeProviderInstanceDeps["queryFactory"];
	readonly claudeRunnerFactory?: ClaudeProviderInstanceDeps["runnerFactory"];
}

/** The real daemon owner, supplied with this fixture's store and project registry. */
export function makeTestProviderAdaptersLayer(
	options: TestAdapterOptions = {},
) {
	const projectId = options.projectId ?? "test-project";
	const configDir = options.configDir ?? "/tmp/conduit-test-adapters";
	const sdk =
		options.claudeSdk ??
		(options.claudeQueryFactory
			? { query: options.claudeQueryFactory }
			: undefined);
	const owner = makeProviderAdaptersLive(configDir, {
		...(sdk ? { claudeSdk: sdk } : {}),
		...(options.claudeRunnerFactory
			? { claudeRunnerFactory: options.claudeRunnerFactory }
			: {}),
	}).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.effect(
					CursorAccountResources,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(CursorAccountResources);
						return Option.isSome(shared)
							? shared.value
							: cursorAccountResourcesFixture(createCursorSdkPort());
					}),
				),
				Layer.effect(
					DaemonConfigRefTag,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(DaemonConfigRefTag);
						return Option.isSome(shared)
							? shared.value
							: yield* Ref.make(makeDaemonConfigFromOptions({}));
					}),
				),
				Layer.effect(
					PersistenceStore,
					Effect.context<PersistenceStoreContext>(),
				),
				Layer.effect(
					SessionActivityTag,
					Effect.gen(function* () {
						const shared = yield* Effect.serviceOption(SessionActivityTag);
						return Option.isSome(shared)
							? shared.value
							: yield* makeSessionActivity;
					}),
				),
				Layer.effect(
					ProjectRegistryTag,
					Ref.make<ProjectRegistryState>(
						HashMap.make([
							projectId,
							{
								_tag: "Registering" as const,
								project: {
									slug: projectId,
									title: projectId,
									folders: [options.workspaceRoot ?? configDir] as const,
								},
							},
						]),
					),
				),
			),
		),
	);
	return Layer.effect(
		ProviderAdapters,
		Effect.gen(function* () {
			const adapters = yield* ProviderAdapters;
			const projects = yield* ProjectRegistryTag;
			return {
				...adapters,
				registerProject: (id, context, onBackgroundWorkChanged) =>
					Effect.gen(function* () {
						const config = Context.getOption(context, ConfigTag);
						if (Option.isSome(config))
							yield* Ref.update(projects, (current) =>
								HashMap.set(current, id, {
									_tag: "Registering",
									project: {
										slug: id,
										title: id,
										folders: [config.value.projectDir],
									},
								}),
							);
						yield* adapters.registerProject(
							id,
							context,
							onBackgroundWorkChanged,
						);
					}),
			} satisfies ProviderAdapters["Service"];
		}),
	).pipe(Layer.provide(owner));
}

export function makeTestOrchestrationRuntimeLayer(
	options: OrchestrationRuntimeLayerOptions & TestAdapterOptions = {},
) {
	return makeOrchestrationRuntimeLayer(options).pipe(
		Layer.provideMerge(makeTestProviderAdaptersLayer(options)),
	);
}

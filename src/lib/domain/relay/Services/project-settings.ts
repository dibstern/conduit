// Project Settings Subscription (conduit-test-ni8.12)
// Project-global settings a tab must hear about when someone else changes them:
// another tab, or the CLI over the same RPC contract.
//
// These are not in the read model — persisted defaults also live in relay
// memory — so there is no version to resume from and no advance to follow.
// A writer reloads the persisted state before publishing, and every
// subscribe opens with a snapshot of the current facts. Subscribing before
// reading means a write that lands in between arrives twice, never zero
// times; each fact is a whole slot, so twice is harmless.

import {
	Context,
	Effect,
	Either,
	FiberMap,
	Layer,
	Option,
	PubSub,
	Ref,
	Stream,
} from "effect";
import { PROVIDER_DRIVERS } from "../../../contracts/provider-instance.js";
import type {
	GlobalProjectSetting,
	GlobalSettingTag,
	HarnessDefaultState,
	ProjectSetting,
	ProjectSettingsEnvelope,
} from "../../../contracts/ws-rpc.js";
import {
	catalogFromProviderList,
	type Harness,
	harnessDefaultPick,
	harnessForModelProvider,
	resolveTurnSettings,
} from "../../../provider/turn-settings.js";
import {
	loadRelaySettings,
	parseDefaultModel,
	type RelaySettings,
} from "../../../relay/relay-settings.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { ConfigTag, OpenCodeModelServiceTag } from "./services.js";
import {
	type OverridesState,
	OverridesStateTag,
} from "./session-overrides-state.js";

type ProjectSettingChange = Extract<
	ProjectSettingsEnvelope,
	{ readonly _tag: "upsert" }
>;

/** Facts the relay observes rather than reads from config. */
type LiveProjectFact = Extract<
	ProjectSetting,
	{
		readonly _tag:
			| "clientCount"
			| "opencodeConnection"
			| "providerModels"
			| "harnessDefaults";
	}
>;
/** OpenCode connections are kept per instance. */
type LiveProjectFacts = {
	readonly clientCount?: Extract<LiveProjectFact, { _tag: "clientCount" }>;
	readonly [instance: `opencodeConnection:${string}`]: Extract<
		LiveProjectFact,
		{ _tag: "opencodeConnection" }
	>;
	readonly providerModels?: Extract<
		LiveProjectFact,
		{ _tag: "providerModels" }
	>;
	readonly [account: `providerModels:${string}`]: Extract<
		LiveProjectFact,
		{ _tag: "providerModels" }
	>;
	readonly harnessDefaults?: Extract<
		LiveProjectFact,
		{ _tag: "harnessDefaults" }
	>;
};
const isLiveFact = (setting: ProjectSetting): setting is LiveProjectFact =>
	setting._tag === "clientCount" ||
	setting._tag === "opencodeConnection" ||
	setting._tag === "providerModels" ||
	setting._tag === "harnessDefaults";

export interface ProjectSettings {
	readonly changes: PubSub.PubSub<ProjectSettingChange>;
	/** Keep an older read from publishing after a newer one on this relay. */
	readonly globalSync: Effect.Semaphore;
	/** Share a pending Claude catalogue refresh for each account. */
	readonly modelDiscovery: FiberMap.FiberMap<string, void, never>;
	/**
	 * Open subscriptions: each tab holds one for its attached project.
	 * Read synchronously by the relay status snapshot, like its own counts.
	 */
	readonly browsers: {
		readonly count: () => number;
		readonly add: (delta: number) => Effect.Effect<number>;
	};
	/** Counts publications; it orders envelopes and is not a resume cursor. */
	readonly revision: Ref.Ref<number>;
	/** The latest of each live fact, which has no other home to read from. */
	readonly live: Ref.Ref<LiveProjectFacts>;
}

export class ProjectSettingsTag extends Context.Tag("ProjectSettings")<
	ProjectSettingsTag,
	ProjectSettings
>() {}

export const ProjectSettingsLive: Layer.Layer<ProjectSettingsTag> =
	Layer.scoped(
		ProjectSettingsTag,
		Effect.all({
			changes: PubSub.unbounded<ProjectSettingChange>(),
			globalSync: Effect.makeSemaphore(1),
			modelDiscovery: FiberMap.make<string, void, never>(),
			browsers: Effect.sync(() => {
				let count = 0;
				return {
					count: () => count,
					add: (delta: number) => Effect.sync(() => (count += delta)),
				};
			}),
			revision: Ref.make(0),
			live: Ref.make<LiveProjectFacts>({}),
		}),
	);

/** Tell every open subscriber about a setting that was just written. */
export const publishProjectSetting = (setting: ProjectSetting) =>
	Effect.gen(function* () {
		const { changes, revision, live } = yield* ProjectSettingsTag;
		if (isLiveFact(setting))
			yield* Ref.update(live, (facts) =>
				setting._tag === "opencodeConnection"
					? { ...facts, [`${setting._tag}:${setting.instanceId}`]: setting }
					: setting._tag === "providerModels" && setting.accountId !== undefined
						? { ...facts, [`${setting._tag}:${setting.accountId}`]: setting }
						: { ...facts, [setting._tag]: setting },
			);
		const sequence = yield* Ref.updateAndGet(revision, (n) => n + 1);
		yield* PubSub.publish(changes, {
			_tag: "upsert" as const,
			item: setting,
			sequence,
		});
	});

const readHarnessDefaults = Effect.gen(function* () {
	const config = yield* ConfigTag;
	const settings = loadRelaySettings(config.configDir);
	const facts = yield* Ref.get((yield* ProjectSettingsTag).live);
	const modelService = yield* Effect.serviceOption(OpenCodeModelServiceTag);
	const openCode =
		modelService._tag === "Some"
			? yield* modelService.value.cachedProviders()
			: undefined;
	const openCodeCatalog =
		openCode?._tag === "Some"
			? openCode.value.providers.flatMap((provider) =>
					(provider.models ?? []).map((model) => ({
						...model,
						providerId: provider.id,
					})),
				)
			: undefined;
	const directory = yield* Effect.serviceOption(AccountDirectory);
	const defaultAccount = Option.isSome(directory)
		? yield* directory.value.defaultFor("claude")
		: Option.none();
	const claudeModels = Option.isSome(defaultAccount)
		? (facts[`providerModels:${defaultAccount.value.id}`] ??
			facts.providerModels)
		: facts.providerModels;
	const claudeCatalog = claudeModels
		? catalogFromProviderList(claudeModels.providers)
		: undefined;
	const state = (harness: Harness): HarnessDefaultState => {
		const candidate = harnessDefaultPick(
			harness,
			settings,
			openCode?._tag === "Some" ? openCode.value.nativeDefaultModel : undefined,
		);
		if (!candidate) return { status: "missing" };
		const pick = {
			...candidate.model,
			effort: candidate.effort,
			contextWindow: candidate.contextWindow,
		};
		const catalog =
			PROVIDER_DRIVERS[harness].catalogSource === "discovery"
				? claudeCatalog
				: openCodeCatalog;
		if (
			catalog === undefined &&
			harnessForModelProvider(pick.providerId) === harness
		)
			return { pick, status: "unverified" };
		const resolved = resolveTurnSettings(candidate, catalog ?? []);
		return Either.isLeft(resolved)
			? { pick, status: "invalid", problem: resolved.left.message }
			: {
					pick: {
						...resolved.right.model,
						effort: resolved.right.effort,
						contextWindow: resolved.right.contextWindow,
					},
					status: "ok",
				};
	};
	return {
		_tag: "harnessDefaults",
		claude: state("claude"),
		opencode: state("opencode"),
	} as const;
});

/** Catalog-dependent state is always recomputed on the receiving relay. */
export const refreshHarnessDefaults: Effect.Effect<void> = Effect.gen(
	function* () {
		const config = yield* Effect.serviceOption(ConfigTag);
		const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
		if (config._tag === "None" || projectSettings._tag === "None") return;
		yield* Effect.flatMap(readHarnessDefaults, publishProjectSetting).pipe(
			Effect.provideService(ConfigTag, config.value),
			Effect.provideService(ProjectSettingsTag, projectSettings.value),
		);
	},
);

const globalSettingRows = (
	settings: RelaySettings,
	defaults: OverridesState,
) => {
	const defaultModel = defaults.defaultModel ?? defaults.nativeDefaultModel;
	return {
		defaultModel: {
			_tag: "defaultModel",
			...(defaultModel
				? {
						model: defaultModel.modelID,
						provider: defaultModel.providerID,
					}
				: {}),
			variant: defaults.defaultVariant,
		},
		visibility: {
			_tag: "visibility",
			hiddenModels: settings.hiddenModels ?? [],
			hiddenAgents: settings.hiddenAgents ?? [],
		},
		defaultPermissionMode: {
			_tag: "defaultPermissionMode",
			mode: defaults.defaultPermissionMode,
		},
		defaultSessionMode: {
			_tag: "defaultSessionMode",
			mode: settings.defaultSessionMode ?? "local",
		},
		defaultGroupingMode: {
			_tag: "defaultGroupingMode",
			mode: settings.defaultGroupingMode ?? "repository",
		},
		claudeSettings: {
			_tag: "claudeSettings",
			overrides: settings.claudeSettings ?? {},
		},
	} satisfies Record<GlobalProjectSetting["_tag"], GlobalProjectSetting>;
};

/** Reload and commit together so a delayed startup cannot restore old defaults. */
export const refreshGlobalDefaults = Effect.gen(function* () {
	const config = yield* ConfigTag;
	return yield* Ref.modify(yield* OverridesStateTag, (state) => {
		const settings = loadRelaySettings(config.configDir);
		const defaultModel = parseDefaultModel(settings.defaultModel);
		const next: OverridesState = {
			...state,
			defaultModel,
			defaultVariant:
				defaultModel && settings.defaultModel
					? (settings.defaultVariants?.[settings.defaultModel] ?? "")
					: "",
			defaultPermissionMode: settings.defaultPermissionMode ?? "ask",
		};
		return [globalSettingRows(settings, next), next];
	});
});

/** Receiving a notification only reloads and publishes locally. */
export const syncGlobalSetting = (tag: GlobalSettingTag) =>
	Effect.gen(function* () {
		const { globalSync } = yield* ProjectSettingsTag;
		yield* globalSync.withPermits(1)(
			Effect.gen(function* () {
				const rows = yield* refreshGlobalDefaults;
				if (tag !== "harnessDefaults") yield* publishProjectSetting(rows[tag]);
				if (tag === "harnessDefaults" || tag === "defaultModel")
					yield* refreshHarnessDefaults;
			}),
		);
	});

/** The origin converges from disk too, before notifying the daemon. */
export const publishGlobalProjectSetting = (tag: GlobalSettingTag) =>
	Effect.gen(function* () {
		yield* syncGlobalSetting(tag);
		yield* (yield* ConfigTag).publishGlobalSetting(tag);
	});

const readProjectSettings = Effect.gen(function* () {
	const config = yield* ConfigTag;
	const defaults = yield* Ref.get(yield* OverridesStateTag);
	const harnessDefaults = yield* readHarnessDefaults;
	return [
		...Object.values(
			globalSettingRows(loadRelaySettings(config.configDir), defaults),
		),
		...Object.values(yield* Ref.get((yield* ProjectSettingsTag).live)).filter(
			(fact) => fact._tag !== "harnessDefaults",
		),
		harnessDefaults,
	] satisfies readonly ProjectSetting[];
});

export const subscribeProjectSettings = (): Stream.Stream<
	ProjectSettingsEnvelope,
	never,
	ProjectSettingsTag | OverridesStateTag | ConfigTag
> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const { changes, revision, globalSync, browsers } =
				yield* ProjectSettingsTag;
			// Count this tab before subscribing: its own join reaches it through
			// the snapshot, and every other open tab through the stream.
			const countBrowser = (delta: number) =>
				globalSync.withPermits(1)(
					Effect.flatMap(browsers.add(delta), (count) =>
						publishProjectSetting({ _tag: "clientCount", count }),
					),
				);
			yield* Effect.acquireRelease(countBrowser(1), () => countBrowser(-1));
			const dequeue = yield* PubSub.subscribe(changes);
			const rows = yield* readProjectSettings;
			const head: readonly ProjectSettingsEnvelope[] = [
				{ _tag: "snapshot", rows, sequence: yield* Ref.get(revision) },
				{ _tag: "synchronized" },
			];
			return Stream.concat(
				Stream.fromIterable(head),
				Stream.fromQueue(dequeue),
			);
		}),
	);

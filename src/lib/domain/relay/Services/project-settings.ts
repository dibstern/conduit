// Project Settings Subscription (conduit-test-ni8.12)
// Project-global settings a tab must hear about when someone else changes them:
// another tab, or the CLI over the same RPC contract.
//
// These are not in the read model — the default model lives in relay memory,
// the rest in settings.jsonc — so there is no version to resume from and no
// advance to follow. A writer publishes the fact it just wrote, and every
// subscribe opens with a snapshot of the current facts. Subscribing before
// reading means a write that lands in between arrives twice, never zero
// times; each fact is a whole slot, so twice is harmless.

import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect";
import type {
	ProjectSetting,
	ProjectSettingsEnvelope,
} from "../../../contracts/ws-rpc.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import { ConfigTag } from "./services.js";
import {
	getDefaultModel,
	getDefaultPermissionMode,
	getDefaultVariant,
	type OverridesStateTag,
} from "./session-overrides-state.js";

type ProjectSettingChange = Extract<
	ProjectSettingsEnvelope,
	{ readonly _tag: "upsert" }
>;

/** Facts the relay observes rather than reads from config. */
type LiveProjectFact = Extract<
	ProjectSetting,
	{ readonly _tag: "clientCount" | "opencodeConnection" }
>;
/** OpenCode connections are kept per instance. */
type LiveProjectFacts = {
	readonly clientCount?: Extract<LiveProjectFact, { _tag: "clientCount" }>;
	readonly [instance: `opencodeConnection:${string}`]: Extract<
		LiveProjectFact,
		{ _tag: "opencodeConnection" }
	>;
};
const isLiveFact = (setting: ProjectSetting): setting is LiveProjectFact =>
	setting._tag === "clientCount" || setting._tag === "opencodeConnection";

export interface ProjectSettings {
	readonly changes: PubSub.PubSub<ProjectSettingChange>;
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
	Layer.effect(
		ProjectSettingsTag,
		Effect.all({
			changes: PubSub.unbounded<ProjectSettingChange>(),
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
				setting._tag === "clientCount"
					? { ...facts, clientCount: setting }
					: { ...facts, [`opencodeConnection:${setting.instanceId}`]: setting },
			);
		const sequence = yield* Ref.updateAndGet(revision, (n) => n + 1);
		yield* PubSub.publish(changes, {
			_tag: "upsert" as const,
			item: setting,
			sequence,
		});
	});

const readProjectSettings = Effect.gen(function* () {
	const config = yield* ConfigTag;
	const settings = loadRelaySettings(config.configDir);
	const defaultModel = yield* getDefaultModel();
	return [
		{
			_tag: "defaultModel",
			...(defaultModel
				? { model: defaultModel.modelID, provider: defaultModel.providerID }
				: {}),
			variant: yield* getDefaultVariant(),
		},
		{
			_tag: "visibility",
			hiddenModels: settings.hiddenModels ?? [],
			hiddenAgents: settings.hiddenAgents ?? [],
		},
		{ _tag: "defaultPermissionMode", mode: yield* getDefaultPermissionMode() },
		{ _tag: "claudeSettings", overrides: settings.claudeSettings ?? {} },
		...Object.values(yield* Ref.get((yield* ProjectSettingsTag).live)),
	] satisfies readonly ProjectSetting[];
});

export const subscribeProjectSettings = (): Stream.Stream<
	ProjectSettingsEnvelope,
	never,
	ProjectSettingsTag | OverridesStateTag | ConfigTag
> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const { changes, revision } = yield* ProjectSettingsTag;
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

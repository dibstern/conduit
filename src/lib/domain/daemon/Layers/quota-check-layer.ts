import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { loadClaudeSdkTestModule } from "../../../provider/claude/claude-sdk-module.js";
import {
	type ClaudeUsageProbeOptions,
	makeClaudeUsageProbe,
} from "../../../provider/claude/claude-usage-probe.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonStateTag } from "../Services/daemon-state.js";
import { InstanceManagerStateTag } from "../Services/instance-manager-service.js";
import { makeQuotaCheck, QuotaCheckTag } from "../Services/quota-check.js";

/** One instance for the daemon, shared by every project's continuation module. */
export const QuotaCheckLive = (options: ClaudeUsageProbeOptions = {}) =>
	Layer.scoped(
		QuotaCheckTag,
		Effect.gen(function* () {
			const state = yield* DaemonStateTag;
			// Live accounts: DaemonState only holds the instances read at startup.
			const accounts = yield* InstanceManagerStateTag;
			const config = yield* Effect.serviceOption(DaemonConfigRefTag);
			const sdk = options.queryFactory
				? undefined
				: yield* loadClaudeSdkTestModule;
			const initial = yield* Ref.get(state);
			return yield* makeQuotaCheck({
				order: Option.isSome(config)
					? Ref.get(config.value).pipe(
							Effect.map((current) => current.usageLimits?.order ?? []),
						)
					: Effect.succeed([]),
				instances: Effect.gen(function* () {
					const { instances } = yield* Ref.get(accounts);
					const fallback = Option.isSome(config)
						? (yield* Ref.get(config.value)).claudeConfigDir
						: undefined;
					return Array.from(HashMap.values(instances))
						.filter((instance) => instance.driver === "claude")
						.map((instance) => {
							const configDir = instance.configDir ?? fallback;
							return {
								id: instance.id,
								...(configDir === undefined ? {} : { configDir }),
								...(instance.env ? { env: instance.env } : {}),
							};
						});
				}),
				probe: makeClaudeUsageProbe({
					...options,
					cwd: options.cwd ?? initial.configDir,
					...(sdk ? { queryFactory: sdk.claudeSdk.query } : {}),
				}),
			});
		}),
	);

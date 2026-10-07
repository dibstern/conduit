import { Context, Deferred, Effect } from "effect";
import type {
	ClaudeQuotaAccount,
	ClaudeUsageProbe,
} from "../../../provider/claude/claude-usage-probe.js";
import type { QuotaCheckResult } from "../../../provider/claude/claude-usage-schema.js";

export type { QuotaCheckResult } from "../../../provider/claude/claude-usage-schema.js";

export interface QuotaCheck {
	readonly check: (instanceId: string) => Effect.Effect<QuotaCheckResult>;
	readonly pickFailover: (
		excluding: string,
	) => Effect.Effect<string | undefined>;
}

export class QuotaCheckTag extends Context.Tag("QuotaCheck")<
	QuotaCheckTag,
	QuotaCheck
>() {}

export const makeQuotaCheck = (options: {
	readonly instances: Effect.Effect<readonly ClaudeQuotaAccount[]>;
	readonly probe: ClaudeUsageProbe;
}) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const lock = yield* Effect.makeSemaphore(1);
		const inFlight = new Map<string, Deferred.Deferred<QuotaCheckResult>>();
		const check: QuotaCheck["check"] = (instanceId) =>
			Effect.gen(function* () {
				const instance = (yield* options.instances).find(
					(account) => account.id === instanceId,
				);
				if (!instance)
					return {
						_tag: "Unavailable",
						reason: "Claude account is not configured",
					} satisfies QuotaCheckResult;
				const result = yield* lock.withPermits(1)(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const existing = inFlight.get(instanceId);
							if (existing) return existing;
							const pending = yield* Deferred.make<QuotaCheckResult>();
							inFlight.set(instanceId, pending);
							const probe = Effect.suspend(() =>
								options.probe.probe(instance),
							).pipe(
								Effect.timeoutTo({
									duration: "5 seconds",
									onTimeout: () =>
										({ _tag: "Unknown" }) satisfies QuotaCheckResult,
									onSuccess: (value) => value,
								}),
								Effect.catchAllCause(() =>
									Effect.succeed({
										_tag: "Unknown",
									} satisfies QuotaCheckResult),
								),
								Effect.flatMap((value) =>
									Effect.sync(() => inFlight.delete(instanceId)).pipe(
										Effect.andThen(Deferred.succeed(pending, value)),
									),
								),
								Effect.ensuring(
									Effect.sync(() => {
										if (inFlight.get(instanceId) === pending)
											inFlight.delete(instanceId);
									}),
								),
							);
							yield* Effect.forkIn(restore(probe), scope);
							return pending;
						}),
					),
				);
				return yield* Deferred.await(result);
			});
		const pickFailover: QuotaCheck["pickFailover"] = (excluding) =>
			Effect.gen(function* () {
				for (const instance of yield* options.instances) {
					if (instance.id === excluding) continue;
					const result = yield* check(instance.id);
					if (result._tag !== "Limited" && result._tag !== "Unavailable")
						return instance.id;
				}
				return undefined;
			});
		return { check, pickFailover } satisfies QuotaCheck;
	});

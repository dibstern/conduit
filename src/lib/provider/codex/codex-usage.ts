import { Effect } from "effect";
import type { UsageWindow } from "../../contracts/limit-recovery.js";
import type { UsageRead, UsageReader } from "../usage-reader.js";
import {
	AccountReadResponseSchema,
	GetAccountRateLimitsResponseSchema,
	type RateLimitSnapshotSchema,
} from "./app-server/protocol.js";
import { openCodexDiscoveryClient } from "./codex-discovery.js";
import { prepareCodexAccount } from "./codex-home.js";

/** limitId is opaque. Use the backend label, including Spark, rather than model-name guesses. */
export function codexUsageReading(
	response: typeof GetAccountRateLimitsResponseSchema.Type,
	sparse = false,
): UsageRead {
	const buckets = {
		[response.rateLimits.limitId ?? "codex"]: response.rateLimits,
		...response.rateLimitsByLimitId,
	};
	const windows: UsageWindow[] = Object.entries(buckets).flatMap(
		([id, bucket]) =>
			(["primary", "secondary"] as const).flatMap((slot): UsageWindow[] => {
				const window = bucket[slot];
				if (!window) return [];
				const mins = window.windowDurationMins;
				const kind =
					mins === 300 ? "five_hour" : mins === 10080 ? "seven_day" : "custom";
				const duration =
					mins === 300
						? "5h"
						: mins === 10080
							? "Week"
							: mins
								? `${mins}m`
								: slot;
				const name =
					bucket.limitName ||
					(id === "codex" ? "Codex" : bucket.normalModelSlug || id);
				const reset =
					window.resetsAt == null
						? undefined
						: new Date(window.resetsAt * 1000);
				return [
					{
						id: `${id}:${slot}`,
						limitId: id,
						...(bucket.normalModelSlug
							? { modelId: bucket.normalModelSlug }
							: {}),
						...(!sparse ||
						((bucket.limitName || bucket.normalModelSlug || id === "codex") &&
							mins != null)
							? {
									label: `${name} ${duration}`,
								}
							: {}),
						kind,
						utilization: Math.max(0, Math.min(100, window.usedPercent)),
						...(reset && Number.isFinite(reset.getTime())
							? { resetsAt: reset.toISOString() }
							: {}),
					},
				];
			}),
	);
	return {
		status: windows.some((window) => window.utilization >= 100)
			? "limited"
			: windows.length
				? "available"
				: "unknown",
		windows,
		...(response.rateLimits.planType
			? { planLabel: response.rateLimits.planType }
			: {}),
	};
}

/** A rolling update is sparse: null metadata does not erase a known value. */
export function mergeCodexRateLimits(
	previous: typeof RateLimitSnapshotSchema.Type | undefined,
	update: typeof RateLimitSnapshotSchema.Type,
): typeof RateLimitSnapshotSchema.Type {
	return {
		...previous,
		...Object.fromEntries(
			Object.entries(update).filter(([, value]) => value != null),
		),
		...(update.primary
			? {
					primary: {
						...previous?.primary,
						...Object.fromEntries(
							Object.entries(update.primary).filter(
								([, value]) => value != null,
							),
						),
						usedPercent: update.primary.usedPercent,
					},
				}
			: {}),
		...(update.secondary
			? {
					secondary: {
						...previous?.secondary,
						...Object.fromEntries(
							Object.entries(update.secondary).filter(
								([, value]) => value != null,
							),
						),
						usedPercent: update.secondary.usedPercent,
					},
				}
			: {}),
	};
}

export const makeCodexUsageReader = (configDir?: string): UsageReader => ({
	read: (account) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { home, env } = yield* prepareCodexAccount(
					{
						id: account.id,
						configuredFolder: account.configDir,
						env: account.env,
					},
					configDir,
				);
				const client = yield* openCodexDiscoveryClient(
					home,
					env,
					"codex-usage",
					true,
				);
				const authentication = yield* client.request(
					"account/read",
					{},
					AccountReadResponseSchema,
				);
				if (!authentication.account)
					return {
						status: "unavailable",
						windows: [],
						reason: "Codex isn't signed in. Run codex login.",
					} satisfies UsageRead;
				return codexUsageReading(
					yield* client.request(
						"account/rateLimits/read",
						{},
						GetAccountRateLimitsResponseSchema,
					),
				);
			}),
		).pipe(
			Effect.catch(() =>
				Effect.succeed<UsageRead>({
					status: "unavailable",
					windows: [],
					reason: "Codex usage could not be read. Try again.",
				}),
			),
		),
});

export const codexUsageReader = makeCodexUsageReader();

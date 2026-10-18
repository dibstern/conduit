import { Result as Either, Option, Schema } from "effect";
import type { UsageWindow } from "../../contracts/limit-recovery.js";
import type { UsageRead } from "../usage-reader.js";

const ClaudeUsageWindowSchema = Schema.Struct({
	utilization: Schema.NullOr(
		Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
	),
	resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const ClaudeModelLimitSchema = Schema.Struct({
	kind: Schema.Literal("weekly_scoped"),
	percent: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
	resets_at: Schema.optional(Schema.NullOr(Schema.String)),
	scope: Schema.Struct({
		model: Schema.Struct({ display_name: Schema.NonEmptyTrimmedString }),
	}),
});

/** Decode only quota fields; the experimental control may add unrelated data. */
export const ClaudeUsageResponseSchema = Schema.Struct({
	rate_limits_available: Schema.Boolean,
	rate_limits: Schema.NullOr(
		Schema.Struct({
			five_hour: Schema.optional(Schema.NullOr(ClaudeUsageWindowSchema)),
			seven_day: Schema.optional(Schema.NullOr(ClaudeUsageWindowSchema)),
			// Entries decode one by one below, so an unfamiliar entry is skipped
			// instead of failing the plan windows.
			limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
			extra_usage: Schema.optional(
				Schema.NullOr(Schema.Struct({ is_enabled: Schema.Boolean })),
			),
		}),
	),
});

export function decodeClaudeUsage(response: unknown): UsageRead {
	const decoded = Schema.decodeUnknownEither(ClaudeUsageResponseSchema)(
		response,
	);
	if (
		Either.isLeft(decoded) ||
		!decoded.right.rate_limits_available ||
		!decoded.right.rate_limits
	)
		return { status: "unknown", windows: [] };
	const limits = decoded.right.rate_limits;
	const readWindow = (
		kind: "five_hour" | "seven_day" | "seven_day_model",
		window: typeof ClaudeUsageWindowSchema.Type | null | undefined,
	): UsageWindow | undefined => {
		if (!window || window.utilization === null) return;
		const millis = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
		return {
			kind,
			utilization: Math.min(100, window.utilization),
			...(window.resets_at && Number.isFinite(millis)
				? { resetsAt: window.resets_at }
				: {}),
		};
	};
	const planWindows = [
		readWindow("five_hour", limits.five_hour),
		readWindow("seven_day", limits.seven_day),
	].filter((window): window is UsageWindow => window !== undefined);
	const limited = planWindows.some((window) => window.utilization >= 100);
	if (limited && limits.extra_usage?.is_enabled) {
		// Extra usage may still fund a turn after the plan window is exhausted.
		// Its budget/eligibility cannot be inferred from this control response.
		return { status: "unknown", windows: [] };
	}
	const windows = [...planWindows];
	for (const entry of limits.limits ?? []) {
		const limit = Schema.decodeUnknownOption(ClaudeModelLimitSchema)(entry);
		if (Option.isNone(limit)) continue;
		const window = readWindow("seven_day_model", {
			utilization: limit.value.percent,
			resets_at: limit.value.resets_at,
		});
		if (window)
			windows.push({
				...window,
				kind: "seven_day_model",
				model: limit.value.scope.model.display_name,
			});
	}
	return {
		status: limited
			? "limited"
			: planWindows.length === 0
				? "unknown"
				: "available",
		windows,
	};
}

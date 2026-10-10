import { Either, Schema } from "effect";
import type { UsageWindow } from "../../contracts/limit-recovery.js";
import type { UsageRead } from "../usage-reader.js";

const ClaudeUsageWindowSchema = Schema.Struct({
	utilization: Schema.NullOr(
		Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
	),
	resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Decode only quota fields; the experimental control may add unrelated data. */
export const ClaudeUsageResponseSchema = Schema.Struct({
	rate_limits_available: Schema.Boolean,
	rate_limits: Schema.NullOr(
		Schema.Struct({
			five_hour: Schema.optional(Schema.NullOr(ClaudeUsageWindowSchema)),
			seven_day: Schema.optional(Schema.NullOr(ClaudeUsageWindowSchema)),
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
	const readWindow = (
		kind: "five_hour" | "seven_day",
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
	const windows = [
		readWindow("five_hour", decoded.right.rate_limits.five_hour),
		readWindow("seven_day", decoded.right.rate_limits.seven_day),
	].filter((window): window is UsageWindow => window !== undefined);
	if (windows.some((window) => window.utilization >= 100)) {
		// Extra usage may still fund a turn after the plan window is exhausted.
		// Its budget/eligibility cannot be inferred from this control response.
		if (decoded.right.rate_limits.extra_usage?.is_enabled)
			return { status: "unknown", windows: [] };
		return { status: "limited", windows };
	}
	return { status: windows.length === 0 ? "unknown" : "available", windows };
}

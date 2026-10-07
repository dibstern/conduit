import { Either, Schema } from "effect";

const UsageWindowSchema = Schema.Struct({
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
			five_hour: Schema.optional(Schema.NullOr(UsageWindowSchema)),
			seven_day: Schema.optional(Schema.NullOr(UsageWindowSchema)),
			extra_usage: Schema.optional(
				Schema.NullOr(Schema.Struct({ is_enabled: Schema.Boolean })),
			),
		}),
	),
});

export interface QuotaWindow {
	readonly utilization: number;
	/** Unix seconds, matching session limitRecovery. */
	readonly resetsAt?: number;
}

export type QuotaCheckResult =
	| {
			readonly _tag: "Available";
			readonly fiveHour?: QuotaWindow;
			readonly sevenDay?: QuotaWindow;
	  }
	| {
			readonly _tag: "Limited";
			readonly rateLimitType: string;
			readonly resetsAt?: number;
	  }
	| { readonly _tag: "Unavailable"; readonly reason: string }
	| { readonly _tag: "Unknown" };

export function decodeClaudeUsage(response: unknown): QuotaCheckResult {
	const decoded = Schema.decodeUnknownEither(ClaudeUsageResponseSchema)(
		response,
	);
	if (
		Either.isLeft(decoded) ||
		!decoded.right.rate_limits_available ||
		!decoded.right.rate_limits
	)
		return { _tag: "Unknown" };
	const readWindow = (
		window: typeof UsageWindowSchema.Type | null | undefined,
	): QuotaWindow | undefined => {
		if (!window || window.utilization === null) return;
		const millis = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
		return {
			utilization: window.utilization,
			...(Number.isFinite(millis) ? { resetsAt: millis / 1000 } : {}),
		};
	};
	const fiveHour = readWindow(decoded.right.rate_limits.five_hour);
	const sevenDay = readWindow(decoded.right.rate_limits.seven_day);
	for (const [rateLimitType, window] of [
		["five_hour", fiveHour],
		["seven_day", sevenDay],
	] as const) {
		if (window && window.utilization >= 100) {
			// Extra usage may still fund a turn after the plan window is exhausted.
			// Its budget/eligibility cannot be inferred from this control response.
			if (decoded.right.rate_limits.extra_usage?.is_enabled)
				return { _tag: "Unknown" };
			return {
				_tag: "Limited",
				rateLimitType,
				...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
			};
		}
	}
	if (!fiveHour && !sevenDay) return { _tag: "Unknown" };
	return {
		_tag: "Available",
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
	};
}

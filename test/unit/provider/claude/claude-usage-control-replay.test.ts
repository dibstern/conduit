// Failure modes: experimental response fields drift; the probe launches under
// the wrong account configDir; the decoded quota maps incorrectly; the query
// remains open after its control request completes.
// Failure modes for picker usage: showing the lower window as the share used,
// hiding measured utilization, or blocking accounts whose plan does not apply.
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeUsage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { makeClaudeUsageReader } from "../../../../src/lib/provider/claude/claude-usage-probe.js";
import {
	ClaudeUsageResponseSchema,
	decodeClaudeUsage,
} from "../../../../src/lib/provider/claude/claude-usage-schema.js";

it("replays the captured usage control response through Usage", async () => {
	const response: unknown = JSON.parse(
		readFileSync(
			new URL(
				"../../../fixtures/claude-sdk-traces/usage-control-response.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const decoded = Schema.decodeUnknownSync(ClaudeUsageResponseSchema)(response);
	expect(decoded.rate_limits_available).toBe(true);
	let closed = false;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const service = yield* makeUsage({
					accounts: Effect.succeed([
						{
							id: "captured-account",
							harness: "claude",
							configDir: "/captured-account",
						},
					]),
					readers: {
						claude: makeClaudeUsageReader({
							queryFactory: ({ options }) => {
								expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(
									"/captured-account",
								);
								return {
									initializationResult: async () => ({
										account: {
											email: "captured@example.test",
											tokenSource: "oauth",
										},
									}),
									usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
										async (options) => {
											expect(options).toEqual({ skipBehaviors: true });
											return response;
										},
									close: () => {
										closed = true;
									},
								};
							},
						}),
					},
				});
				const [result] = yield* service.refresh(["captured-account"]);
				expect(["available", "limited"]).toContain(result?.status);
				expect(result?.windows).toEqual([
					{
						kind: "five_hour",
						utilization: decoded.rate_limits?.five_hour?.utilization,
						resetsAt: decoded.rate_limits?.five_hour?.resets_at,
					},
					{
						kind: "seven_day",
						utilization: decoded.rate_limits?.seven_day?.utilization,
						resetsAt: decoded.rate_limits?.seven_day?.resets_at,
					},
				]);
			}),
		),
	);
	expect(closed).toBe(true);
});

it("uses the highest measured window and leaves non-plan accounts unknown", () => {
	expect(
		decodeClaudeUsage({
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 71 },
				seven_day: { utilization: 23 },
			},
		}),
	).toEqual({
		status: "available",
		windows: [
			{ kind: "five_hour", utilization: 71 },
			{ kind: "seven_day", utilization: 23 },
		],
	});
	expect(
		decodeClaudeUsage({ rate_limits_available: false, rate_limits: null }),
	).toEqual({ status: "unknown", windows: [] });
});

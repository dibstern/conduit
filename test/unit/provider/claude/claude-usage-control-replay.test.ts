// Failure modes: experimental response fields drift; the probe launches under
// the wrong account configDir; the decoded quota maps incorrectly; the query
// remains open after its control request completes.
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeQuotaCheck } from "../../../../src/lib/domain/daemon/Services/quota-check.js";
import { makeClaudeUsageProbe } from "../../../../src/lib/provider/claude/claude-usage-probe.js";
import { ClaudeUsageResponseSchema } from "../../../../src/lib/provider/claude/claude-usage-schema.js";

it("replays the captured usage control response through QuotaCheck", async () => {
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
				const service = yield* makeQuotaCheck({
					instances: Effect.succeed([
						{ id: "captured-account", configDir: "/captured-account" },
					]),
					probe: makeClaudeUsageProbe({
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
				});
				const result = yield* service.check("captured-account");
				expect(["Available", "Limited"]).toContain(result._tag);
				if (result._tag === "Available") {
					expect(result.fiveHour?.utilization).toBe(
						decoded.rate_limits?.five_hour?.utilization,
					);
					expect(result.sevenDay?.utilization).toBe(
						decoded.rate_limits?.seven_day?.utilization,
					);
				}
			}),
		),
	);
	expect(closed).toBe(true);
});

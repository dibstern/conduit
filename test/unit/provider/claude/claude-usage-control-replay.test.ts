// Failure modes: experimental response fields drift; the probe launches under
// the wrong account configDir; the decoded quota maps incorrectly; the query
// remains open after its control request completes.
// Failure modes for picker usage: showing the lower window as the share used,
// hiding measured utilization, or blocking accounts whose plan does not apply.
// Model windows must preserve response order, skip unnamed/unmeasured entries,
// and never change account status, including when extra usage is enabled.
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeUsage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { makeClaudeUsageReader } from "../../../../src/lib/provider/claude/claude-usage-probe.js";
import {
	ClaudeUsageResponseSchema,
	decodeClaudeUsage,
} from "../../../../src/lib/provider/claude/claude-usage-schema.js";

it.each([
	{ fixture: "usage-control-response.json", status: "available" },
	{ fixture: "usage-control-response-work.json", status: "unknown" },
])("replays $fixture through Usage", async ({ fixture, status }) => {
	const response: unknown = JSON.parse(
		readFileSync(
			new URL(
				`../../../fixtures/claude-sdk-traces/${fixture}`,
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
						codex: { read: () => Effect.die("Unexpected Codex usage read") },
						cursor: { read: () => Effect.die("Unexpected Cursor usage read") },
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
				expect(result?.status).toBe(status);
				expect(result?.windows).toEqual(
					status === "unknown"
						? []
						: [
								{
									kind: "five_hour",
									utilization: decoded.rate_limits?.five_hour?.utilization,
									resetsAt: decoded.rate_limits?.five_hour?.resets_at,
									history: [
										{
											at: result?.readAt,
											utilization: decoded.rate_limits?.five_hour?.utilization,
										},
									],
								},
								{
									kind: "seven_day",
									utilization: decoded.rate_limits?.seven_day?.utilization,
									resetsAt: decoded.rate_limits?.seven_day?.resets_at,
									history: [
										{
											at: result?.readAt,
											utilization: decoded.rate_limits?.seven_day?.utilization,
										},
									],
								},
								{
									kind: "seven_day_model",
									model: "Fable",
									utilization: 0,
									resetsAt: "2026-10-14T06:00:00+00:00",
								},
							],
				);
			}),
		),
	);
	expect(closed).toBe(true);
});

it.each([
	100, 125,
])("keeps a captured model window at %i%% informational", (percent) => {
	const response = Schema.decodeUnknownSync(ClaudeUsageResponseSchema)(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../fixtures/claude-sdk-traces/usage-control-response.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const limits = response.rate_limits;
	const modelLimit = limits?.limits?.find(
		(limit): limit is Record<string, unknown> =>
			typeof limit === "object" &&
			limit !== null &&
			"kind" in limit &&
			limit.kind === "weekly_scoped",
	);
	if (!limits || !modelLimit) throw new Error("Missing captured model limit");
	const windows = [
		{
			kind: "seven_day_model",
			model: "Fable",
			utilization: 100,
			resetsAt: "2026-10-14T06:00:00+00:00",
		},
	];
	const modelLimits = [{ ...modelLimit, percent }];
	const plan = decodeClaudeUsage({
		...response,
		rate_limits: { ...limits, limits: null },
	});
	expect(
		decodeClaudeUsage({
			...response,
			rate_limits: { ...limits, limits: modelLimits },
		}),
	).toEqual({
		status: "available",
		windows: [...plan.windows, ...windows],
	});
	expect(
		decodeClaudeUsage({
			...response,
			rate_limits: {
				...limits,
				five_hour: null,
				seven_day: null,
				limits: modelLimits,
			},
		}),
	).toEqual({ status: "unknown", windows });
	expect(
		decodeClaudeUsage({
			...response,
			rate_limits: {
				...limits,
				five_hour: { utilization: 100 },
				limits: modelLimits,
			},
		}).status,
	).toBe("limited");
	expect(
		decodeClaudeUsage({
			...response,
			rate_limits: {
				...limits,
				five_hour: { utilization: 100 },
				extra_usage: { is_enabled: true },
				limits: modelLimits,
			},
		}),
	).toEqual({ status: "unknown", windows: [] });
});

it("skips unreported models and tolerates unknown limit kinds and reset dates", () => {
	const response = Schema.decodeUnknownSync(ClaudeUsageResponseSchema)(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../fixtures/claude-sdk-traces/usage-control-response.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const limits = response.rate_limits;
	const modelLimit = limits?.limits?.find(
		(limit): limit is Record<string, unknown> =>
			typeof limit === "object" &&
			limit !== null &&
			"kind" in limit &&
			limit.kind === "weekly_scoped",
	);
	if (!limits || !modelLimit) throw new Error("Missing captured model limit");
	expect(
		decodeClaudeUsage({
			...response,
			rate_limits: {
				five_hour: null,
				seven_day: null,
				limits: [
					{ kind: "future_kind", future_field: true },
					{ ...modelLimit, percent: null },
					{ ...modelLimit, scope: null },
					{ ...modelLimit, scope: { model: null } },
					{ ...modelLimit, scope: { model: {} } },
					{ ...modelLimit, scope: { model: { display_name: " " } } },
					{ ...modelLimit, resets_at: "not a date" },
					{
						...modelLimit,
						scope: { model: { display_name: "Sonnet" } },
						percent: 6,
						resets_at: null,
					},
				],
			},
		}),
	).toEqual({
		status: "unknown",
		windows: [
			{ kind: "seven_day_model", model: "Fable", utilization: 0 },
			{ kind: "seven_day_model", model: "Sonnet", utilization: 6 },
		],
	});
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

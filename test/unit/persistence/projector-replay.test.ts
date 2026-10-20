import { Schema } from "effect";
import { expect, it } from "vitest";
import { LimitRecoverySchema } from "../../../src/lib/contracts/limit-recovery.js";
import {
	type StoredEvent,
	StoredEventSchema,
} from "../../../src/lib/persistence/events.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import resumedTurnEvents from "../../fixtures/claude-resumed-turn.json" with {
	type: "json",
};
import { resumeLegacyTags } from "../../fixtures/resume-legacy-tags.js";
import { makeEffectProjectionHarness } from "../../helpers/effect-projection-harness.js";

// Pin every projector's tables before changing the coverage declarations.
// This catches altered dispatch, projector ordering, writes, and row versions.
it("preserves every read model from the recorded Claude event log", async () => {
	const harness = makeEffectProjectionHarness();
	const sessionId = "ses_c2d8cd521bc14f9f8f7700096bbf1d23";
	try {
		await harness.reproject([
			{
				type: "session.created",
				data: { sessionId, title: "Recorded turn", provider: "claude" },
				eventId: "recorded-session-created",
				sessionId,
				projectId: "test-project",
				sequence: 609185,
				streamVersion: 0,
				metadata: {},
				provider: "claude",
				createdAt: 1789508753984,
			},
			...resumedTurnEvents.map(
				(event, index) =>
					({
						...event,
						eventId: `recorded-${event.sequence}`,
						sessionId,
						projectId: "test-project",
						streamVersion: index + 1,
						metadata: {},
					}) as StoredEvent,
			),
		]);
		const rows: Record<string, readonly object[]> = {};
		for (const table of [
			"sessions",
			"messages",
			"message_parts",
			"turns",
			"session_providers",
			"pending_approvals",
			"pending_inputs",
			"session_goal_checks",
			"session_sidebar",
		]) {
			rows[table] = await harness.query(`SELECT * FROM ${table} ORDER BY 1`);
		}
		expect(rows).toMatchSnapshot();
	} finally {
		await harness.dispose();
	}
});

it("preserves session rows and Limit Recovery from resume-legacy-tags", async () => {
	const harness = makeEffectProjectionHarness();
	try {
		await harness.reproject(
			resumeLegacyTags.map((event) =>
				Schema.decodeUnknownSync(StoredEventSchema)(event),
			),
		);
		const sessions = await harness.query<SessionRow>(
			"SELECT * FROM sessions ORDER BY id",
		);
		expect({
			sessions,
			limitRecoveries: sessions.map((row) => ({
				id: row.id,
				limitRecovery:
					row.limit_recovery == null
						? null
						: Schema.decodeSync(Schema.fromJsonString(LimitRecoverySchema))(
								row.limit_recovery,
							),
			})),
		}).toMatchSnapshot();
	} finally {
		await harness.dispose();
	}
});

it.each([
	{ by: "user", source: "limit-policy", auto: undefined, rearms: 0 },
	{ by: "policy", source: "continuation-sweep", auto: true, rearms: 0 },
	{ by: "sweep", source: "limit-policy", auto: undefined, rearms: 1 },
] as const)("projects by=$by ahead of legacy metadata", async ({
	by,
	source,
	auto,
	rearms,
}) => {
	const harness = makeEffectProjectionHarness();
	try {
		await harness.reproject(
			resumeLegacyTags
				.filter((event) => event.sessionId === "policy")
				.map((event) =>
					event.type === "session.resume_scheduled"
						? {
								...event,
								data: { ...event.data, by },
								metadata: { source },
							}
						: event,
				),
		);
		const [session] = await harness.query<SessionRow>(
			"SELECT * FROM sessions WHERE id = 'policy'",
		);
		const recovery = Schema.decodeUnknownSync(
			Schema.fromJsonString(LimitRecoverySchema),
		)(session?.limit_recovery);
		expect(recovery.scheduledAt).toBe(1791234000);
		expect(recovery.auto).toBe(auto);
		expect(recovery.rearms).toBe(rearms);
	} finally {
		await harness.dispose();
	}
});

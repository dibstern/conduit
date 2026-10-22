import { expect, it } from "vitest";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import resumedTurnEvents from "../../fixtures/claude-resumed-turn.json" with {
	type: "json",
};
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
			"provider_runs",
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

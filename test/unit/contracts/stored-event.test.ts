import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeStoredEventRow } from "../../../src/lib/persistence/effect/stored-event-row.js";
import fixture from "../../fixtures/stored-event-compatibility.json" with {
	type: "json",
};

describe("tool completion outcome", () => {
	it.each([
		{ metadata: { isError: true }, outcome: undefined, expected: "failed" },
		{ metadata: { isError: false }, outcome: undefined, expected: "succeeded" },
		{ metadata: {}, outcome: undefined, expected: "succeeded" },
		{
			metadata: { isError: true },
			outcome: "succeeded",
			expected: "succeeded",
		},
		{ metadata: {}, outcome: "failed", expected: "failed" },
	])("decodes $outcome with legacy $metadata as $expected", ({
		metadata,
		outcome,
		expected,
	}) => {
		const event = Effect.runSync(
			decodeStoredEventRow(
				{
					project_id: "project",
					sequence: 1,
					event_id: "event",
					session_id: "session",
					stream_version: 0,
					type: "tool.completed",
					data: JSON.stringify({
						messageId: "message",
						partId: "part",
						duration: 1,
						metadata,
						outcome,
					}),
					metadata: "{}",
					provider: "codex",
					created_at: 1,
				},
				(cause) => cause,
			),
		);
		expect(event.data).toMatchObject({ outcome: expected });
	});
});

// Verdicts captured before the canonical declaration refactor. Includes the
// real claude-resumed-turn rows, historical payloads, and malformed stored JSON.
describe("stored event compatibility", () => {
	it.each(fixture)("$label (accepted=$accepted)", ({ row, accepted }) => {
		const result = Effect.runSync(
			Effect.result(decodeStoredEventRow(row, (cause) => cause)),
		);
		expect(result._tag === "Success").toBe(accepted);
		if (result._tag === "Success") {
			// Reads preserve unknown fields and add the tool completion outcome default.
			const data = JSON.parse(row.data);
			expect(result.success).toEqual({
				projectId: row.project_id,
				sequence: row.sequence,
				eventId: row.event_id,
				sessionId: row.session_id,
				streamVersion: row.stream_version,
				type: row.type,
				data:
					row.type === "tool.completed"
						? {
								...data,
								outcome:
									data.outcome ??
									(data.metadata?.isError === true ? "failed" : "succeeded"),
							}
						: data,
				metadata: JSON.parse(row.metadata),
				provider: row.provider,
				createdAt: row.created_at,
			});
		}
	});
});

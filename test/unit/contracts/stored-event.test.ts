import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeStoredEventRow } from "../../../src/lib/persistence/effect/stored-event-row.js";
import fixture from "../../fixtures/stored-event-compatibility.json" with {
	type: "json",
};

// Verdicts captured before the canonical declaration refactor. Includes the
// real claude-resumed-turn rows, historical payloads, and malformed stored JSON.
describe("stored event compatibility", () => {
	it.each(fixture)("$label (accepted=$accepted)", ({ row, accepted }) => {
		const result = Effect.runSync(
			Effect.either(decodeStoredEventRow(row, (cause) => cause)),
		);
		expect(result._tag === "Right").toBe(accepted);
		if (result._tag === "Right") {
			// Reads return the raw payload and metadata, including unknown fields.
			expect(result.right).toEqual({
				projectId: row.project_id,
				sequence: row.sequence,
				eventId: row.event_id,
				sessionId: row.session_id,
				streamVersion: row.stream_version,
				type: row.type,
				data: JSON.parse(row.data),
				metadata: JSON.parse(row.metadata),
				provider: row.provider,
				createdAt: row.created_at,
			});
		}
	});
});

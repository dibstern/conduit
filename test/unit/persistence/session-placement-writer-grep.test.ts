import { describe, expect, it } from "vitest";
import { placementWrites } from "./session-placement-writes.js";

describe("session placement writers", () => {
	it("recognizes session INSERTs and UPDATEs, excluding message parents and reads", () => {
		for (const column of ["parent_id", "forked_from"]) {
			expect(
				placementWrites(
					`INSERT INTO sessions (id, ${column}) VALUES (?, ?)`,
					column,
				),
			).toHaveLength(1);
			expect(
				placementWrites(
					`UPDATE sessions SET title = ?, ${column} = ? WHERE id = ?`,
					column,
				),
			).toHaveLength(1);
			expect(
				placementWrites(
					`INSERT INTO messages (id, ${column}) VALUES (?, ?); UPDATE messages SET ${column} = ?`,
					column,
				),
			).toHaveLength(0);
			expect(
				placementWrites(
					`SELECT ${column} FROM sessions; UPDATE sessions SET title = ? WHERE ${column} = ?`,
					column,
				),
			).toHaveLength(0);
		}
	});
});

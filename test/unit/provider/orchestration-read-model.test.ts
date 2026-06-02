import { describe, expect, it } from "vitest";
import {
	CommandReadModelRepository,
	isCommandScopeTombstoned,
} from "../../../src/lib/provider/orchestration-read-model.js";

describe("CommandReadModelRepository", () => {
	it("bootstraps command receipts without loading UI projection tables", () => {
		const queries: string[] = [];
		const db = {
			query: <T>(sql: string): T[] => {
				queries.push(sql);
				return [
					{
						command_id: "cmd-1",
						session_id: "session-1",
						status: "side_effect_requested",
						result_sequence: null,
						error: null,
						created_at: 1000,
					},
					{
						command_id: "cmd-2",
						session_id: "session-2",
						status: "side_effect_completed",
						result_sequence: 42,
						error: null,
						created_at: 2000,
					},
				] as T[];
			},
			queryOne: <T>(sql: string): T => {
				queries.push(sql);
				return { last_sequence: 42 } as T;
			},
		};

		const snapshot = new CommandReadModelRepository(db).bootstrap();

		expect(snapshot.lastEventSequence).toBe(42);
		expect(snapshot.receipts.get("cmd-1")).toMatchObject({
			commandId: "cmd-1",
			sessionId: "session-1",
			status: "side_effect_requested",
		});
		expect(snapshot.receipts.get("cmd-2")).toMatchObject({
			commandId: "cmd-2",
			resultSequence: 42,
			status: "side_effect_completed",
		});
		expect(isCommandScopeTombstoned(snapshot, "session", "session-1")).toBe(
			false,
		);

		const queryText = queries.join("\n");
		expect(queryText).toContain("command_receipts");
		expect(queryText).toContain("events");
		expect(queryText).not.toMatch(
			/\b(sessions|messages|message_parts|turns|pending_approvals)\b/,
		);
	});
});

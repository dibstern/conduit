import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyReplayParity } from "../../../src/lib/persistence/replay-parity.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Replay parity through the relay", () => {
	let harness: RelayHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async () => {
		try {
			await harness?.stop();
		} finally {
			harness = undefined;
			mkdirSync("test-results/replay-parity", { recursive: true });
			writeFileSync(
				"test-results/replay-parity/relay-flow.json",
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
		}
	});

	// Failure cases: tool results lose their event pointers, deleted
	// sidebar tombstones count as live rows, or a mismatch escapes the report.
	it("replays a tool result, fork and deletion and reports copied-store corruption", async () => {
		harness = await createRelayHarness("chat-tool-call");
		evidence = {
			ticket: "conduit-test-hiuf.2",
			ignoredProjectionColumns: [
				"version",
				"session_sidebar.row.version",
				"sessions.history_complete",
			],
		};
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Replay parity", {
			providerId: "opencode",
		});
		const sessionId = await client.sendMessage(
			'Read package.json and tell me the "version" field.',
			{ sessionId: String(created["id"]) },
		);
		await client.waitForTranscriptMessage(
			(message) =>
				message.parts?.some(
					(part) =>
						part.type === "tool" && part.state?.["status"] === "completed",
				) === true,
			sessionId,
			15_000,
		);
		// This recording ends at the tool result, so close its native turn too.
		harness.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		await client.waitForTurnEnd(sessionId);
		const nativeForkId = "ses_replay_parity_fork";
		harness.mock.setExactResponse("POST", `/session/${sessionId}/fork`, 200, {
			id: nativeForkId,
			projectID: "replay-parity",
			directory: process.cwd(),
			version: "1.3.0",
			title: "Replay parity (fork)",
			time: { created: Date.now(), updated: Date.now() },
		});
		harness.mock.setExactResponse(
			"GET",
			`/session/${nativeForkId}/message`,
			200,
			[],
		);
		const forked = await client.forkSession({ sessionId });
		const forkId = String(forked["id"]);
		expect(forkId).not.toBe(sessionId);
		await client.deleteSession(forkId);

		const source = new Database(harness.eventsDbPath, { readonly: true });
		const copyDir = mkdtempSync(join(tmpdir(), "conduit-replay-parity-test-"));
		try {
			await vi.waitFor(() => {
				expect(
					source.prepare("SELECT id FROM sessions WHERE id = ?").get(forkId),
				).toBeUndefined();
				expect(
					source
						.prepare("SELECT row FROM session_sidebar WHERE session_id = ?")
						.get(forkId),
				).toEqual({ row: null });
				expect(
					source
						.prepare(
							"SELECT mp.id FROM message_parts mp JOIN messages m ON m.id = mp.message_id WHERE m.session_id = ? AND mp.type = 'tool' AND mp.status = 'completed' AND mp.result IS NOT NULL",
						)
						.all(sessionId),
				).not.toHaveLength(0);
			});
			evidence["deletedSidebarTombstone"] = source
				.prepare(
					"SELECT session_id, row FROM session_sidebar WHERE session_id = ?",
				)
				.get(forkId);
			const report = await harness.checkReplayParity();
			evidence["sessionId"] = sessionId;
			evidence["forkId"] = forkId;
			evidence["parity"] = report;
			expect(report.diffs).toEqual([]);
			expect(report.danglingPartPointers).toEqual([]);
			expect(report.counts.sessions).toBeGreaterThan(0);
			expect(report.counts.events).toBeGreaterThan(0);
			expect(report.counts.tables["message_parts"]?.expected).toBeGreaterThan(
				0,
			);

			const copyPath = join(copyDir, "events.db");
			await source.backup(copyPath);
			const copy = new DatabaseSync(copyPath);
			try {
				const part = copy
					.prepare(
						"SELECT mp.id FROM message_parts mp JOIN messages m ON m.id = mp.message_id WHERE m.session_id = ? AND mp.type = 'tool' AND mp.status = 'completed' LIMIT 1",
					)
					.get(sessionId);
				if (!part) throw new Error("Session has no completed tool result");
				const partId = String(part["id"]);
				const resultEventSeq = Number(
					copy.prepare("SELECT MAX(sequence) + 1 AS next FROM events").get()?.[
						"next"
					],
				);
				copy
					.prepare("UPDATE sessions SET title = 'Corrupted copy' WHERE id = ?")
					.run(sessionId);
				copy
					.prepare("UPDATE message_parts SET result_event_seq = ? WHERE id = ?")
					.run(resultEventSeq, partId);
				copy
					.prepare("UPDATE session_sidebar SET row = '{' WHERE session_id = ?")
					.run(sessionId);
				const corrupted = await Effect.runPromise(
					verifyReplayParity(copy, { projectId: "integration-test" }),
				);
				evidence["corruptedCopy"] = corrupted;
				expect(
					corrupted.diffs.some(
						(diff) =>
							diff.table === "sessions" && diff.fields.includes("title"),
					),
				).toBe(true);
				expect(
					corrupted.diffs.some(
						(diff) =>
							diff.table === "session_sidebar" && diff.fields.includes("row"),
					),
				).toBe(true);
				expect(corrupted.danglingPartPointers).toContainEqual({
					partId,
					resultEventSeq,
				});
			} finally {
				copy.close();
			}
		} finally {
			source.close();
			rmSync(copyDir, { recursive: true, force: true });
		}
	}, 30_000);
});

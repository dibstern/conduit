// OpenCode metadata stays server-side even when it shares Cursor presentation keys.
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Tool presentation compatibility through the relay", () => {
	let harness: RelayHarness;
	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);
	afterAll(async () => {
		if (harness) await harness.stop();
	});
	it("keeps OpenCode tool metadata out of browser rows without changing status", async () => {
		const client = await harness.connectWsClient();
		try {
			await client.waitForInitialState();
			const sessionId = client.getActiveSessionId();
			if (!sessionId) throw new Error("No initial session");
			const partID = "part-opencode-metadata";
			const output = "file1.txt\n".repeat(30_000);
			const metadata = {
				output,
				exit: 0,
				exitCode: 0,
				truncated: true,
				isError: true,
				progress: "provider-private progress",
				fileChange: { filePath: "private.ts" },
				plan: { content: "provider-private plan" },
				computerUse: { actions: [] },
				media: [{ url: "provider-private media" }],
			};
			const inject = (status: "running" | "completed") =>
				harness.mock.injectSSEEvents([
					{
						type: "message.part.updated",
						properties: {
							partID,
							messageID: "msg-opencode-metadata",
							sessionID: sessionId,
							part: {
								id: partID,
								messageID: "msg-opencode-metadata",
								sessionID: sessionId,
								type: "tool",
								callID: "toolu_opencode_metadata",
								tool: "bash",
								state: {
									status,
									input: { command: "ls" },
									...(status === "completed" && { output }),
									metadata,
								},
							},
						},
					},
				]);
			inject("running");
			const running = await client.waitForToolState(
				partID,
				"running",
				sessionId,
			);
			expect(running.state).not.toHaveProperty("metadata");
			expect(running.state).not.toHaveProperty("output");
			inject("completed");
			const completed = await client.waitForToolState(
				partID,
				"completed",
				sessionId,
			);
			expect(completed.state?.output).toEqual({
				_tag: "preview",
				text: output.slice(0, 2_000),
				fullBytes: Buffer.byteLength(output),
			});
			expect(JSON.stringify(completed).length).toBeLessThan(3_000);
			expect(completed.state).not.toHaveProperty("metadata");
			expect(completed.state).not.toHaveProperty("error");
			const db = new Database(harness.eventsDbPath, { readonly: true });
			try {
				const stored = db
					.prepare<[string], { status: string; metadata: string }>(
						"SELECT status, metadata FROM message_parts WHERE id = ?",
					)
					.get(partID);
				expect(stored?.status).toBe("completed");
				expect(JSON.parse(stored?.metadata ?? "null")).toEqual(metadata);
			} finally {
				db.close();
			}
			await client.close();
			const reopened = await harness.connectWsClient();
			try {
				await reopened.waitForInitialState();
				const history = await reopened.waitForToolState(
					partID,
					"completed",
					sessionId,
				);
				expect(history.state).toEqual(completed.state);
			} finally {
				await reopened.close();
			}
		} finally {
			await client.close();
		}
	}, 15_000);
});

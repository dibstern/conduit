// A text file sent to a real, temporary OpenCode server. OpenCode expands a
// text/plain file part into two synthetic user text parts (a Read-tool
// preamble and the decoded contents) beside the file part itself.
// Failure modes: the live transcript shows the contents as the user's own
// words; the store keeps them, so history and ThreadRead repeat the file next
// to its chip; the filter also hides text the user typed.
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../../e2e/helpers/opencode-spawner.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

// Re-check on an OpenCode bump: the free roster churns.
const FREE_MODEL = "opencode/mimo-v2.6-flash-free";
const CONTENTS = "conduit-attachment-marker-7f3a\n";
const PROMPT = "Reply with just the word 'ok'.";

describe("Integration: OpenCode text file attachment", () => {
	let opencode: SpawnedOpenCode;
	let harness: RelayHarness;
	let client: TestWsClient;

	beforeAll(async () => {
		opencode = await spawnOpenCode({
			env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: FREE_MODEL }) },
		});
		harness = await createRelayHarness("chat-simple", {
			opencodeUrl: opencode.url,
			defaultModel: FREE_MODEL,
		});
		client = await harness.connectWsClient();
		await client.waitForInitialState();
	}, 60_000);

	afterAll(async () => {
		await client?.close();
		await harness?.stop();
		opencode?.stop();
	});

	it("shows the file once, as a file, live and in history", async () => {
		const created = await client.createSession();
		const sessionId = created["id"] as string;
		const turnEnd = client.waitForTurnEnd(sessionId, 120_000);
		await client.sendMessage(PROMPT, {
			sessionId,
			images: [
				`data:text/plain;name=notes.txt;base64,${Buffer.from(CONTENTS).toString("base64")}`,
			],
		});
		await turnEnd;

		// OpenCode really did add its synthetic parts, so the test can fail.
		const res = await fetch(`${opencode.url}/session/${sessionId}/message`);
		const upstream = (await res.json()) as {
			info: { role: string };
			parts: { type: string; synthetic?: boolean; text?: string }[];
		}[];
		const upstreamUser = upstream.find((m) => m.info.role === "user");
		expect(
			upstreamUser?.parts.filter((p) => p.type === "text" && p.synthetic),
		).toHaveLength(2);

		const userTexts = (parts: readonly { type: string; text?: unknown }[]) =>
			parts.filter((p) => p.type === "text").map((p) => p.text);

		const live = client
			.getReceivedOfType("transcript_message")
			.filter((m) => m["sessionId"] === sessionId && m["role"] === "user")
			.flatMap((m) =>
				userTexts((m["parts"] ?? []) as { type: string; text?: unknown }[]),
			);
		expect(live.length).toBeGreaterThan(0);
		for (const text of live) expect(text).toBe(PROMPT);

		const db = new Database(harness.eventsDbPath, { readonly: true });
		const stored = db
			.prepare(
				`SELECT p.type, p.text FROM message_parts p JOIN messages m ON m.id = p.message_id
				  WHERE m.session_id = ? AND m.role = 'user' ORDER BY p.sort_order`,
			)
			.all(sessionId) as { type: string; text: string | null }[];
		db.close();
		expect(stored.map((p) => p.type).sort()).toEqual(["file", "text"]);
		expect(stored.find((p) => p.type === "text")?.text).toBe(PROMPT);

		const fresh = await harness.connectWsClient();
		try {
			await fresh.waitForInitialState();
			const page = await fresh.loadMoreHistory(sessionId);
			const user = page.messages.filter((m) => m.role === "user");
			expect(user).toHaveLength(1);
			expect(userTexts(user[0]?.parts ?? [])).toEqual([PROMPT]);
			expect(user[0]?.parts?.filter((p) => p.type === "file")).toHaveLength(1);
		} finally {
			await fresh.close();
		}
	}, 150_000);
});

// A text file sent to a real, temporary OpenCode server. OpenCode expands a
// text/plain file part into two synthetic user text parts (a Read-tool
// preamble and the decoded contents) beside the file part itself.
// Failure modes: the live transcript shows the contents as the user's own
// words; the store keeps them, so history and ThreadRead repeat the file next
// to its chip; the filter also hides text the user typed.
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../../e2e/helpers/opencode-spawner.js";
import {
	CONTROLLED_MODEL_ID,
	startControlledOpenCodeInference,
} from "../../helpers/controlled-opencode-inference.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

const CONTENTS = "conduit-attachment-marker-7f3a\n";
const PROMPT = "Reply with just the word 'ok'.";

describe("Integration: OpenCode text file attachment", () => {
	let opencode: SpawnedOpenCode;
	let harness: RelayHarness;
	let client: TestWsClient;
	let inference:
		| Awaited<ReturnType<typeof startControlledOpenCodeInference>>
		| undefined;
	let capturedSessionId: string | undefined;
	const evidence: Record<string, unknown> = {
		terminal: "not reached",
		stored: "not reached",
		history: "not reached",
	};

	beforeAll(async () => {
		try {
			inference = await startControlledOpenCodeInference(
				"test-results/controlled-attachment-inference.json",
			);
			opencode = await spawnOpenCode({ env: inference.env });
			await inference.assertOpenCodeConfig(opencode.url);
			harness = await createRelayHarness("chat-simple", {
				opencodeUrl: opencode.url,
				defaultModel: CONTROLLED_MODEL_ID,
			});
			client = await harness.connectWsClient();
			await client.waitForInitialState();
		} catch (error) {
			evidence["setupError"] = String(error).slice(0, 2048);
			await inference?.close();
			throw error;
		}
	}, 60_000);

	afterAll(async () => {
		try {
			if (capturedSessionId) {
				const diagnosticSignal = AbortSignal.timeout(5_000);
				for (const path of [
					`/session/${capturedSessionId}/message`,
					"/session/status",
				]) {
					try {
						const res = await fetch(`${opencode.url}${path}`, {
							signal: diagnosticSignal,
						});
						const body = await res.text();
						evidence[path] = {
							status: res.status,
							body: body.slice(0, 262144),
							truncated: body.length > 262144,
						};
						if (!res.ok)
							throw new Error(`Native diagnostic GET ${path}: ${res.status}`);
					} catch (error) {
						evidence[`${path}:error`] = String(error).slice(0, 2048);
					}
				}
				try {
					const db = new Database(harness.eventsDbPath, { readonly: true });
					try {
						evidence["storedAtCleanup"] = db
							.prepare(
								`SELECT p.type, p.text FROM message_parts p JOIN messages m ON m.id = p.message_id
							 WHERE m.session_id = ? AND m.role = 'user' ORDER BY p.sort_order`,
							)
							.all(capturedSessionId);
					} finally {
						db.close();
					}
				} catch (error) {
					evidence["store:error"] = String(error).slice(0, 2048);
				}
				if (evidence["history"] === "not reached") {
					try {
						evidence["history"] =
							await client.loadMoreHistory(capturedSessionId);
					} catch (error) {
						evidence["history:error"] = String(error).slice(0, 2048);
					}
				}
			}
			evidence["sessionId"] = capturedSessionId;
			const live = JSON.stringify(client?.getReceived() ?? []);
			evidence["live"] = {
				body: live.slice(0, 1048576),
				truncated: live.length > 1048576,
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/opencode-file-attachment.json",
				JSON.stringify(evidence, null, 2),
			);
			inference?.writeEvidence();
		} finally {
			try {
				await client?.close();
			} finally {
				try {
					await harness?.stop();
				} finally {
					try {
						opencode?.stop();
					} finally {
						await inference?.close();
					}
				}
			}
		}
		expect(inference?.errors).toEqual([]);
		expect(
			Object.keys(evidence).filter((key) => key.endsWith(":error")),
		).toEqual([]);
	});

	it("shows the file once, as a file, live and in history", async () => {
		const created = await client.createSession();
		const sessionId = created["id"] as string;
		capturedSessionId = sessionId;
		await client.sendMessage(PROMPT, {
			sessionId,
			images: [
				`data:text/plain;name=notes.txt;base64,${Buffer.from(CONTENTS).toString("base64")}`,
			],
		});
		const terminal = await client.waitForTurnEnd(sessionId, 120_000);
		evidence["terminal"] = terminal;
		expect(terminal.status).toBe("idle");
		expect(terminal.lastTurnEndVersion).toBeGreaterThanOrEqual(0);

		// OpenCode really did add its synthetic parts, so the test can fail.
		const res = await fetch(`${opencode.url}/session/${sessionId}/message`);
		expect(res.ok).toBe(true);
		const upstream = (await res.json()) as {
			info: { role: string };
			parts: { type: string; synthetic?: boolean; text?: string }[];
		}[];
		const upstreamUser = upstream.find((m) => m.info.role === "user");
		evidence["nativeUser"] = upstreamUser;
		expect(
			upstreamUser?.parts.filter((p) => p.type === "text" && p.synthetic),
		).toHaveLength(2);
		expect(
			inference?.requests.some(({ request }) =>
				request.includes(CONTENTS.trim()),
			),
		).toBe(true);
		expect(
			upstream
				.filter((m) => m.info.role === "assistant")
				.flatMap((m) => m.parts)
				.some((p) => p.type === "text" && p.text === "ok"),
		).toBe(true);

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
		evidence["stored"] = stored;
		expect(stored.map((p) => p.type).sort()).toEqual(["file", "text"]);
		expect(stored.find((p) => p.type === "text")?.text).toBe(PROMPT);

		const fresh = await harness.connectWsClient();
		try {
			await fresh.waitForInitialState();
			const page = await fresh.loadMoreHistory(sessionId);
			evidence["history"] = page;
			const user = page.messages.filter((m) => m.role === "user");
			expect(user).toHaveLength(1);
			expect(userTexts(user[0]?.parts ?? [])).toEqual([PROMPT]);
			expect(user[0]?.parts?.filter((p) => p.type === "file")).toHaveLength(1);
		} finally {
			await fresh.close();
		}
	}, 150_000);
});

// Auto-titling OpenCode sessions end to end (conduit-test-o4yo.2), against a
// real, temporary OpenCode server with controlled local inference.
// Conduit's title model is stubbed; OpenCode keeps its native title-agent guard.
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { isRecord } from "../../../src/lib/utils.js";
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

const FALLBACK_TITLE = /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

async function* titleReply(title: string): AsyncIterable<unknown> {
	yield {
		type: "assistant",
		message: { content: [{ type: "text", text: title }] },
	};
}

const makeSignal = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("Integration: OpenCode session titles", () => {
	let opencode: SpawnedOpenCode;
	let harness: RelayHarness;
	let client: TestWsClient;
	let inference:
		| Awaited<ReturnType<typeof startControlledOpenCodeInference>>
		| undefined;
	// Each test installs its own title model behind the relay's stub.
	let titleQuery: ClaudeOneShotQueryFactory = () => titleReply("Unused");
	const titleCalls = vi.fn();

	beforeAll(async () => {
		try {
			inference = await startControlledOpenCodeInference(
				"test-results/controlled-title-inference.json",
			);
			opencode = await spawnOpenCode({ env: inference.env });
			await inference.assertOpenCodeConfig(opencode.url);
			harness = await createRelayHarness("chat-simple", {
				opencodeUrl: opencode.url,
				defaultModel: CONTROLLED_MODEL_ID,
				titleQuery: (params) => {
					titleCalls(params);
					return titleQuery(params);
				},
			});
			client = await harness.connectWsClient();
			await client.waitForInitialState();
		} catch (error) {
			await inference?.close();
			throw error;
		}
	}, 60_000);

	afterAll(async () => {
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
		expect(inference?.errors).toEqual([]);
	});

	const conduitTitle = (sessionId: string): string | undefined => {
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const row = db
				.prepare("SELECT title FROM sessions WHERE id = ?")
				.get(sessionId) as { title: string } | undefined;
			return row?.title;
		} finally {
			db.close();
		}
	};

	const renameEvents = (sessionId: string) => {
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			return db
				.prepare(
					`SELECT json_extract(data, '$.title') AS title,
					        json_extract(metadata, '$.source') AS source
					   FROM events
					  WHERE session_id = ? AND type = 'session.renamed'
					  ORDER BY sequence`,
				)
				.all(sessionId) as { title: string; source: string | null }[];
		} finally {
			db.close();
		}
	};

	const opencodeTitle = async (sessionId: string): Promise<string> => {
		const res = await fetch(`${opencode.url}/session/${sessionId}`);
		const body = (await res.json()) as { title: string };
		return body.title;
	};

	const setOpenCodeTitle = (sessionId: string, title: string) =>
		fetch(`${opencode.url}/session/${sessionId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});

	const createUntitledSession = async (): Promise<string> => {
		const created = await client.createSession();
		const sessionId = created["id"] as string;
		expect(await opencodeTitle(sessionId)).toBe("Untitled");
		expect(conduitTitle(sessionId)).toBe("Untitled");
		client.clearReceived();
		return sessionId;
	};

	const send = (sessionId: string, text: string) =>
		client.sendMessage(text, { sessionId, originId: client.getClientId() });

	it("titles the first message in Conduit and OpenCode, and keeps it", async () => {
		titleQuery = () => titleReply("Fix Header Selector");
		titleCalls.mockClear();
		let phase = "create untitled session";
		let requestedId: string | undefined;
		let dispatchedId: string | undefined;
		try {
			const sessionId = await createUntitledSession();
			requestedId = sessionId;

			phase = "first send";
			dispatchedId = await send(sessionId, "Reply with just the word 'pong'.");
			const turnEnd = client.waitForTurnEnd(sessionId, 120_000);
			phase = "first title convergence";
			await vi.waitFor(
				async () => {
					expect(conduitTitle(sessionId)).toBe("Fix Header Selector");
					expect(await opencodeTitle(sessionId)).toBe("Fix Header Selector");
				},
				{ timeout: 15_000 },
			);
			expect(titleCalls).toHaveBeenCalledTimes(1);
			expect(String(titleCalls.mock.calls[0]?.[0]?.prompt)).toContain(
				"Reply with just the word 'pong'.",
			);

			// The turn ran in OpenCode, and its own titler left the session alone.
			phase = "first terminal";
			await turnEnd;
			phase = "native history";
			const messages = (await (
				await fetch(`${opencode.url}/session/${sessionId}/message`)
			).json()) as { info: { role: string } }[];
			expect(messages.map((message) => message.info.role)).toContain(
				"assistant",
			);
			phase = "native title after first terminal";
			expect(await opencodeTitle(sessionId)).toBe("Fix Header Selector");
			expect(conduitTitle(sessionId)).toBe("Fix Header Selector");

			// OpenCode reporting a placeholder title later does not revert it.
			phase = "placeholder update";
			await setOpenCodeTitle(sessionId, "Untitled");
			phase = "placeholder convergence";
			await vi.waitFor(
				() =>
					expect(renameEvents(sessionId)).toContainEqual({
						title: "Untitled",
						source: null,
					}),
				{ timeout: 15_000 },
			);
			expect(conduitTitle(sessionId)).toBe("Fix Header Selector");

			// A follow-up message is not titled again.
			phase = "follow-up send";
			dispatchedId = undefined;
			dispatchedId = await send(sessionId, "Reply with just the word 'ping'.");
			const followUpEnd = client.waitForTurnEnd(sessionId, 120_000);
			phase = "follow-up terminal";
			await followUpEnd;
			expect(titleCalls).toHaveBeenCalledTimes(1);
		} catch (error) {
			try {
				const signal = AbortSignal.timeout(5_000);
				const frames = client.getReceived();
				const rows = frames.flatMap((frame, frameIndex) => {
					if (frame.type !== "shell" && frame.type !== "family") return [];
					const items: unknown[] =
						frame["_tag"] === "upsert"
							? [frame["item"]]
							: frame["_tag"] === "snapshot" && Array.isArray(frame["rows"])
								? frame["rows"]
								: [];
					return items
						.filter(isRecord)
						.filter(
							(row) => row["id"] === requestedId || row["id"] === dispatchedId,
						)
						.map((row) => ({
							frameIndex,
							type: frame.type,
							id: row["id"],
							title: row["title"],
							status: row["status"],
							lastTurnEndVersion: row["lastTurnEndVersion"],
							lastTurnEndInputId: row["lastTurnEndInputId"],
						}));
				});
				const live = JSON.stringify(rows.slice(-16));
				const evidence: Record<string, unknown> = {
					phase,
					requestedSessionId: requestedId ?? null,
					dispatchedSessionId: dispatchedId ?? null,
					publicRows: {
						frameCount: frames.length,
						rowCount: rows.length,
						body: live.slice(-32_768),
						truncated: rows.length > 16 || live.length > 32_768,
						kept: "suffix",
					},
				};
				const paths = ["/session/status"];
				for (const id of new Set([requestedId, dispatchedId])) {
					if (id) paths.push(`/session/${id}`, `/session/${id}/message`);
				}
				for (const path of paths) {
					try {
						const res = await fetch(`${opencode.url}${path}`, { signal });
						const body = await res.text();
						evidence[path] = {
							status: res.status,
							ok: res.ok,
							body: body.slice(0, 16_384),
							truncated: body.length > 16_384,
						};
					} catch (snapshotError) {
						evidence[`${path}:error`] = String(snapshotError).slice(0, 2048);
					}
				}
				console.error(
					"OpenCode title failure diagnostics:",
					JSON.stringify(evidence),
				);
			} catch (diagnosticError) {
				console.error(
					"OpenCode title diagnostic snapshot failed:",
					String(diagnosticError).slice(0, 2048),
				);
			}
			throw error;
		}
	}, 300_000);

	it("lets a manual rename made while titling win in Conduit and OpenCode", async () => {
		const started = makeSignal();
		const release = makeSignal();
		const finished = makeSignal();
		titleQuery = async function* () {
			started.resolve();
			try {
				await release.promise;
				yield* titleReply("Auto Title Too Late");
			} finally {
				finished.resolve();
			}
		};
		titleCalls.mockClear();
		const sessionId = await createUntitledSession();

		await send(sessionId, "Explain the session list sorting.");
		await started.promise;
		await client.renameSession(sessionId, "Manual Title");
		await vi.waitFor(
			async () => {
				expect(conduitTitle(sessionId)).toBe("Manual Title");
				expect(await opencodeTitle(sessionId)).toBe("Manual Title");
			},
			{ timeout: 15_000 },
		);

		release.resolve();
		await finished.promise;
		// Give a late auto-title every chance to land before asserting it didn't.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(titleCalls).toHaveBeenCalledTimes(1);
		expect(conduitTitle(sessionId)).toBe("Manual Title");
		expect(await opencodeTitle(sessionId)).toBe("Manual Title");
		expect(renameEvents(sessionId).map((event) => event.title)).not.toContain(
			"Auto Title Too Late",
		);
	}, 120_000);

	it("falls back to a dated title when the title model fails", async () => {
		titleQuery = async function* () {
			yield* [];
			throw new Error("title model unavailable");
		};
		titleCalls.mockClear();
		const sessionId = await createUntitledSession();

		await send(sessionId, "Summarise the failing tests.");
		await vi.waitFor(
			async () => {
				expect(conduitTitle(sessionId)).toMatch(FALLBACK_TITLE);
				expect(await opencodeTitle(sessionId)).toBe(conduitTitle(sessionId));
			},
			{ timeout: 15_000 },
		);
		expect(titleCalls).toHaveBeenCalledTimes(1);
	}, 120_000);
});

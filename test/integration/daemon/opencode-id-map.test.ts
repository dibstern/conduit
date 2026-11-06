// 82tn.80 failure cases: a call reaches OpenCode under the Conduit id instead of
// the native one; the native session's own events or listings adopt a second
// session under the native id; a stream, poll or reconcile lands under the
// native id; a rewind deletes in the wrong session; after a restart the map is
// lost; a delete leaves the native session behind.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

const EVIDENCE = "test-results/opencode-id-map/opencode-id-map.json";
const SEND_TIMEOUT = 120_000;

describe("a Conduit session whose OpenCode session has another id", () => {
	let harness: ProcessHarness | undefined;
	let modelServer: Server | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			evidence["result"] = task.result?.state;
			if (harness) {
				await harness.dispose();
				harness.assertNoRunners();
			}
		} finally {
			if (modelServer) {
				modelServer.closeAllConnections();
				await new Promise<void>((done) => modelServer?.close(() => done()));
			}
			mkdirSync("test-results/opencode-id-map", { recursive: true });
			const root = harness?.root;
			const text = JSON.stringify(evidence, null, 2);
			writeFileSync(
				EVIDENCE,
				`${root ? text.replaceAll(root, "<ROOT>") : text}\n`,
			);
			harness = undefined;
			modelServer = undefined;
			evidence = {};
		}
	});

	it("sends, streams, polls, rewinds, reconciles and deletes through the native id", async () => {
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: resolveRealOpenCode(),
		});
		harness = fixture;
		// The user turns of every model request; a turn the rewind dropped must not return.
		const modelInputs: string[][] = [];
		modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input = JSON.parse(body) as {
				stream?: boolean;
				messages: Array<{ role: string; content: unknown }>;
			};
			const users = input.messages
				.filter(({ role }) => role === "user")
				.map(({ content }) =>
					typeof content === "string" ? content : JSON.stringify(content),
				);
			modelInputs.push(users);
			const asked = /\b(id-map-[\w-]+)/.exec(users.at(-1) ?? "")?.[1];
			const message = {
				role: "assistant",
				content: `Heard ${asked ?? "nothing"}.`,
			};
			const result = {
				id: "id-map",
				created: 1,
				model: "id-map",
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			};
			if (input.stream) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			} else {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						...result,
						object: "chat.completion",
						choices: [{ index: 0, message, finish_reason: "stop" }],
					}),
				);
			}
		});
		await new Promise<void>((done) =>
			modelServer?.listen(0, "127.0.0.1", done),
		);
		const address = modelServer.address();
		if (!address || typeof address === "string")
			throw new Error("Missing scripted model port");
		const seed = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		);
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				...seed,
				instances: seed?.instances?.map((instance) => ({
					...instance,
					env: {
						...instance.env,
						OPENCODE_CONFIG_CONTENT: JSON.stringify({
							enabled_providers: ["id-map-test"],
							model: "id-map-test/id-map",
							small_model: "id-map-test/id-map",
							permission: { "*": "allow" },
							provider: {
								"id-map-test": {
									npm: "@ai-sdk/openai-compatible",
									options: {
										baseURL: `http://127.0.0.1:${address.port}/v1`,
										apiKey: "test",
									},
									models: {
										"id-map": {
											name: "Scripted id map",
											limit: { context: 16384, output: 1024 },
											cost: { input: 0, output: 0 },
										},
									},
								},
							},
						}),
					},
				})),
			}),
		);
		await fixture.restart();
		const targetDir = join(fixture.root, "project-b");
		mkdirSync(targetDir);
		await fixture.requestRpc({ _tag: "SaveProject", folders: [targetDir] });
		const browser = await fixture.connect();
		await browser.startInstance("managed-test");
		const { sessionId: sourceId } = await fixture.requestRpc({
			_tag: "CreateSession",
			permissionMode: "ask",
			projectSlug: "process-test",
			originId: browser.originId,
			title: "OpenCode source",
			instanceId: AccountIdSchema.make("managed-test"),
			providerId: "opencode",
			model: { providerId: "id-map-test", modelId: "id-map" },
		});
		await browser.send(sourceId, "id-map-source", SEND_TIMEOUT);
		// A fork into another project is a session Conduit names; OpenCode names its own.
		const { sessionId } = await fixture.requestRpc({
			_tag: "ForkSession",
			originId: browser.originId,
			sessionId: sourceId,
			targetProjectSlug: "project-b",
		});
		const store = () =>
			new Database(fixture.daemonStorePath(), { readonly: true });
		const binding = () => {
			const db = store();
			try {
				const row = db
					.prepare(
						"SELECT provider_sid AS native, status, history_complete AS historyComplete FROM sessions WHERE id = ?",
					)
					.get(sessionId) as
					| { native: string | null; status: string; historyComplete: number }
					| undefined;
				const native = row?.native ?? "";
				return {
					row,
					rowsUnderNative: (
						db
							.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?")
							.get(native) as { n: number }
					).n,
					eventsUnderNative: (
						db
							.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
							.get(native) as { n: number }
					).n,
				};
			} finally {
				db.close();
			}
		};
		// The page shows a user message as its text parts (history-logic.ts).
		const userTexts = async (tab: typeof browser) =>
			(await tab.history(sessionId))
				.filter(({ role }) => role === "user")
				.map(({ parts }) =>
					(parts ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n"),
				);
		const created = binding();
		const native = created.row?.native ?? "";
		evidence = { scenario: "opencode id map", sessionId, native, created };
		expect(native).toMatch(/^ses_/);
		expect(native).not.toBe(sessionId);

		const target = await fixture.connect(undefined, undefined, "project-b");
		const streamed = [];
		for (const prompt of ["id-map-kept", "id-map-dropped"])
			streamed.push(
				(await target.send(sessionId, prompt, SEND_TIMEOUT)).chunks.join(""),
			);
		const dropped = (await target.history(sessionId)).find(
			({ role, parts }) =>
				role === "user" &&
				(parts ?? []).some((part) => part.text === "id-map-dropped"),
		);
		if (!dropped) throw new Error("Missing the turn to rewind");
		await Effect.runPromise(
			target.rpc.RewindSession({ sessionId, messageId: dropped.id }),
		);
		// The rewind deletes the native tail when the next turn starts (82tn.55).
		streamed.push(
			(
				await target.send(sessionId, "id-map-after-rewind", SEND_TIMEOUT)
			).chunks.join(""),
		);
		const afterRewind = modelInputs.at(-1) ?? [];

		// Opening the session polls OpenCode's history for it.
		await fixture.connect(sessionId, undefined, "project-b");
		// test-waits-allow polling: the history poll tells no client when it marks the session complete; the store is the only signal.
		await vi.waitFor(() => expect(binding().row?.historyComplete).toBe(1), {
			timeout: 10_000,
		});
		const polled = { ...binding(), shown: await userTexts(target) };

		await fixture.terminate();
		await fixture.restart();
		const reopened = await fixture.connect(undefined, undefined, "project-b");
		await reopened.startInstance("managed-test");
		streamed.push(
			(
				await reopened.send(sessionId, "id-map-after-restart", SEND_TIMEOUT)
			).chunks.join(""),
		);
		// test-waits-allow polling: the reconcile after restart is detached and tells no client; the store is the only signal.
		await vi.waitFor(() => expect(binding().row?.status).toBe("idle"), {
			timeout: 10_000,
		});
		const reconciled = { ...binding(), shown: await userTexts(reopened) };
		const afterRestart = modelInputs.at(-1) ?? [];

		const openCodeData = join(fixture.root, "data", "opencode");
		const openCodeDb = existsSync(openCodeData)
			? readdirSync(openCodeData).find((name) => name.endsWith(".db"))
			: undefined;
		const nativeRows = () => {
			if (!openCodeDb) return undefined;
			const db = new Database(join(openCodeData, openCodeDb), {
				readonly: true,
			});
			try {
				return (
					db
						.prepare("SELECT COUNT(*) AS n FROM session WHERE id = ?")
						.get(native) as { n: number }
				).n;
			} finally {
				db.close();
			}
		};
		const nativeSessionsBeforeDelete = nativeRows();
		await reopened.deleteSession(sessionId);
		// test-waits-allow polling: the upstream delete runs after the reply; OpenCode's own store is the only signal.
		await vi.waitFor(() => expect(nativeRows()).toBe(0), { timeout: 10_000 });

		const proof = {
			streamed,
			droppedReachedModelAfterRewind: afterRewind.some((text) =>
				text.includes("id-map-dropped"),
			),
			keptReachedModelAfterRewind: afterRewind.some((text) =>
				text.includes("id-map-kept"),
			),
			droppedReachedModelAfterRestart: afterRestart.some((text) =>
				text.includes("id-map-dropped"),
			),
			polled,
			reconciled,
			openCodeDb,
			nativeSessionsBeforeDelete,
			nativeSessionsAfterDelete: nativeRows(),
		};
		evidence = { ...evidence, proof };
		const bound = {
			row: expect.objectContaining({ native }),
			rowsUnderNative: 0,
			eventsUnderNative: 0,
		};
		expect(proof).toEqual({
			streamed: [
				"Heard id-map-kept.",
				"Heard id-map-dropped.",
				"Heard id-map-after-rewind.",
				"Heard id-map-after-restart.",
			],
			droppedReachedModelAfterRewind: false,
			keptReachedModelAfterRewind: true,
			droppedReachedModelAfterRestart: false,
			polled: expect.objectContaining({
				...bound,
				shown: ["id-map-source", "id-map-kept", "id-map-after-rewind"],
			}),
			reconciled: expect.objectContaining({
				...bound,
				shown: [
					"id-map-source",
					"id-map-kept",
					"id-map-after-rewind",
					"id-map-after-restart",
				],
			}),
			openCodeDb: expect.any(String),
			nativeSessionsBeforeDelete: 1,
			nativeSessionsAfterDelete: 0,
		});
	});
});

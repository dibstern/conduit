// Failure cases: the fork lists under the source project, runs in the source's
// folder, starts without the source's transcript, or shows the seed that carries
// the transcript as a message the user sent.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

const EVIDENCE = "test-results/m379-11-opencode-fork.json";
const SEND_TIMEOUT = 120_000;

describe("an OpenCode session forks into another project", () => {
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
			mkdirSync("test-results", { recursive: true });
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

	it("starts a fresh session in the target's folder that knows the source's transcript", async () => {
		const binary = resolveRealOpenCode();
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: binary,
		});
		harness = fixture;
		// Every request the scripted model receives, as the text of its messages.
		const modelInputs: string[][] = [];
		modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input = JSON.parse(body) as {
				stream?: boolean;
				messages: Array<{ role: string; content: unknown }>;
			};
			const texts = input.messages.map(
				({ role, content }) =>
					`${role}: ${typeof content === "string" ? content : JSON.stringify(content)}`,
			);
			modelInputs.push(texts);
			const lastUser = input.messages
				.map(({ role }) => role)
				.lastIndexOf("user");
			const asked = JSON.stringify(input.messages[lastUser]?.content);
			const toolDone = input.messages
				.slice(lastUser + 1)
				.some(({ role }) => role === "tool");
			const codename = /codename is (\w+)/.exec(
				input.messages
					.slice(0, lastUser)
					.map(({ content }) => JSON.stringify(content))
					.join("\n"),
			)?.[1];
			const message =
				asked.includes("write the landing file") && !toolDone
					? {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "fork_write",
									type: "function",
									function: {
										name: "bash",
										arguments: JSON.stringify({
											command: "printf 'landed\\n' > fork-landed.txt; pwd",
											description: "Write the landing file",
										}),
									},
								},
							],
						}
					: {
							role: "assistant",
							content: asked.includes("What is the codename")
								? `The codename is ${codename ?? "unknown"}.`
								: toolDone
									? "Wrote the landing file."
									: "Noted.",
						};
			const result = {
				id: "fork-probe",
				created: 1,
				model: "fork",
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			};
			if (input.stream) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				const delta =
					"tool_calls" in message && message.tool_calls
						? {
								...message,
								tool_calls: message.tool_calls.map((call, index) => ({
									...call,
									index,
								})),
							}
						: message;
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }] })}\n\n`,
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
							enabled_providers: ["fork-test"],
							model: "fork-test/fork",
							small_model: "fork-test/fork",
							permission: { "*": "allow" },
							provider: {
								"fork-test": {
									npm: "@ai-sdk/openai-compatible",
									options: {
										baseURL: `http://127.0.0.1:${address.port}/v1`,
										apiKey: "test",
									},
									models: {
										fork: {
											name: "Scripted fork",
											tool_call: true,
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
			model: { providerId: "fork-test", modelId: "fork" },
		});
		await browser.send(
			sourceId,
			"Remember this: the codename is amber.",
			SEND_TIMEOUT,
		);
		const fork = await fixture.requestRpc({
			_tag: "ForkSession",
			originId: browser.originId,
			sessionId: sourceId,
			targetProjectSlug: "project-b",
		});
		const target = await fixture.connect(undefined, undefined, "project-b");
		const wrote = await target.send(
			fork.sessionId,
			"Please write the landing file.",
			SEND_TIMEOUT,
		);
		const answer = await target.send(
			fork.sessionId,
			"What is the codename?",
			SEND_TIMEOUT,
		);
		// Opening the fork reconciles it with OpenCode's history, which holds the seed.
		await fixture.connect(fork.sessionId, undefined, "project-b");
		// The reconcile runs detached and tells no client, so the store is the signal.
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		await vi.waitFor(
			() =>
				expect(
					db
						.prepare("SELECT history_complete FROM sessions WHERE id = ?")
						.get(fork.sessionId),
				).toEqual({ history_complete: 1 }),
			{ timeout: 10_000 },
		);
		const stored = (() => {
			try {
				return {
					...(db
						.prepare(
							"SELECT project_id AS projectId, history_complete AS historyComplete FROM sessions WHERE id = ?",
						)
						.get(fork.sessionId) as {
						projectId: string;
						historyComplete: number;
					}),
					userMessages: (
						db
							.prepare(
								"SELECT text, is_inherited FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ordinal",
							)
							.all(fork.sessionId) as Array<{
							text: string;
							is_inherited: number;
						}>
					).map(({ text, is_inherited }) => ({
						text,
						inherited: is_inherited === 1,
					})),
				};
			} finally {
				db.close();
			}
		})();
		// The page shows a user message as its text parts (history-logic.ts).
		const shown = (await target.history(fork.sessionId))
			.filter(({ role }) => role === "user")
			.map(({ parts }) =>
				(parts ?? [])
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n"),
			);
		const forkInputs = modelInputs.filter((texts) =>
			texts.some((text) => text.includes("write the landing file")),
		);
		const landed = {
			projectSlug: fork.projectSlug,
			projectId: stored.projectId,
			historyComplete: stored.historyComplete,
			landedInTarget: existsSync(join(targetDir, "fork-landed.txt")),
			landedInSource: existsSync(join(fixture.projectDir, "fork-landed.txt")),
			wrote: wrote.chunks.join(""),
			answer: answer.chunks.join(""),
			seedReachedModel: forkInputs[0]?.some(
				(text) =>
					text.startsWith("user: ") &&
					text.includes("[Conduit fork context]") &&
					text.includes("the codename is amber"),
			),
			userMessages: stored.userMessages,
			shown,
		};
		evidence = {
			scenario: "opencode fork into another project",
			targetDir: realpathSync(targetDir),
			landed,
		};
		expect(landed).toEqual({
			projectSlug: "project-b",
			projectId: "project-b",
			historyComplete: 1,
			landedInTarget: true,
			landedInSource: false,
			wrote: "Wrote the landing file.",
			answer: "The codename is amber.",
			seedReachedModel: true,
			userMessages: [
				{ text: "Remember this: the codename is amber.", inherited: true },
				{ text: "Please write the landing file.", inherited: false },
				{ text: "What is the codename?", inherited: false },
			],
			shown: [
				"Remember this: the codename is amber.",
				"Please write the landing file.",
				"What is the codename?",
			],
		});
	});
});

// 82tn.81 failure cases (lane-81 audit rows 3, 5, 6, 7, 10, 11): OpenCode's fork re-ids the
// session and every copied message, so a fork bound under the wrong id duplicates or loses the
// transcript; its copies' events adopt a second session under the native id; a crash between
// the fork and its binding leaves a visible orphan; a fork with files into a worktree is refused.
import { execFileSync } from "node:child_process";
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

const RESULTS = "test-results/opencode-native-fork";
const SEND_TIMEOUT = 120_000;

const git = (cwd: string, args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

describe("an OpenCode fork bound through the id map", () => {
	let harness: ProcessHarness | undefined;
	let modelServer: Server | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			evidence["result"] = task.result?.state;
			if (task.result?.errors?.length) {
				evidence["errors"] = task.result.errors.map(({ message }) => message);
				evidence["logs"] = harness?.logTail;
			}
			if (harness) {
				await harness.dispose();
				harness.assertNoRunners();
			}
		} finally {
			if (modelServer) {
				modelServer.closeAllConnections();
				await new Promise<void>((done) => modelServer?.close(() => done()));
			}
			mkdirSync(RESULTS, { recursive: true });
			const root = harness?.root;
			const text = JSON.stringify(evidence, null, 2);
			writeFileSync(
				join(RESULTS, `${String(evidence["name"])}.json`),
				`${root ? text.replaceAll(root, "<ROOT>") : text}\n`,
			);
			harness = undefined;
			modelServer = undefined;
			evidence = {};
		}
	});

	/** A daemon on a real OpenCode whose model answers "Heard <prompt>." in a git project. */
	const start = async (pauseAt?: "forked" | "bound") => {
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			realOpenCode: resolveRealOpenCode(),
		});
		harness = fixture;
		// The user turns of every model request: a fork must hold exactly its kept path.
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
			const asked = /\b(fork-[\w-]+)/.exec(users.at(-1) ?? "")?.[1];
			const message = {
				role: "assistant",
				content: `Heard ${asked ?? "nothing"}.`,
			};
			const result = {
				id: "fork",
				created: 1,
				model: "fork",
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
		const repo = fixture.projectDir;
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		git(repo, ["init", "-q", "-b", "main"]);
		git(repo, ["add", "."]);
		git(repo, [
			"-c",
			"user.name=Native fork test",
			"-c",
			"user.email=native-fork@example.test",
			"commit",
			"-q",
			"-m",
			"Initial",
		]);
		await fixture.restart(
			pauseAt === undefined
				? {}
				: {
						serviceEnvironment: {
							CONDUIT_TEST_OPENCODE_FORK_PAUSE_AT: pauseAt,
						},
					},
		);
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
		const query = <Row>(statement: string, ...params: string[]) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db.prepare(statement).all(...params) as Row[];
			} finally {
				db.close();
			}
		};
		/** OpenCode's own sessions, from its store. */
		const nativeSessions = () => {
			const data = join(fixture.root, "data", "opencode");
			const file = existsSync(data)
				? readdirSync(data).find((name) => name.endsWith(".db"))
				: undefined;
			if (!file) return [];
			const db = new Database(join(data, file), { readonly: true });
			try {
				return db
					.prepare("SELECT id, title, directory FROM session ORDER BY id")
					.all() as Array<{ id: string; title: string; directory: string }>;
			} finally {
				db.close();
			}
		};
		/** The fork's binding and what the store holds under each id. */
		const binding = (forkId: string) => {
			const [row] = query<{ native: string | null; forkedFrom: string }>(
				"SELECT provider_sid AS native, forked_from AS forkedFrom FROM sessions WHERE id = ?",
				forkId,
			);
			const native = row?.native ?? forkId;
			return {
				native,
				forkedFrom: row?.forkedFrom,
				rowsUnderNative:
					native === forkId
						? 0
						: query("SELECT 1 FROM sessions WHERE id = ?", native).length,
				eventsUnderNative:
					native === forkId
						? 0
						: query("SELECT 1 FROM events WHERE session_id = ?", native).length,
			};
		};
		/** Each user and assistant text the page shows, in order. */
		const transcript = async (sessionId: string) =>
			(await browser.history(sessionId)).map(
				({ role, parts }) =>
					`${role}: ${(parts ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n")}`,
			);
		const messageOf = async (sessionId: string, text: string) => {
			const message = (await browser.history(sessionId)).find(({ parts }) =>
				(parts ?? []).some((part) => part.text === text),
			);
			if (!message) throw new Error(`No message ${text}`);
			return message.id;
		};
		/** Sends a turn, then waits for its run's capture (a fork with files reads it). */
		const turn = async (sessionId: string, prompt: string) => {
			const sent = (await browser.send(sessionId, prompt, SEND_TIMEOUT)).chunks;
			await fixture.requestRpc({
				_tag: "SessionDiffList",
				sessionId,
				scope: { kind: "turn", turnId: await messageOf(sessionId, prompt) },
			});
			return sent.join("");
		};
		return {
			fixture,
			repo,
			browser,
			sourceId,
			modelInputs,
			query,
			nativeSessions,
			binding,
			transcript,
			messageOf,
			turn,
		};
	};

	it("forks at a turn, holds exactly the kept path, and sends on the fork", async () => {
		evidence["name"] = "fork-at-turn";
		const {
			browser,
			sourceId,
			modelInputs,
			binding,
			transcript,
			messageOf,
			turn,
		} = await start();
		await turn(sourceId, "fork-one");
		await turn(sourceId, "fork-two");
		const { sessionId: forkId } = await Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId: sourceId,
				originId: browser.originId,
				messageId: await messageOf(sourceId, "Heard fork-one."),
			}),
		);
		const forked = { ...binding(forkId), shown: await transcript(forkId) };
		const sent = await turn(forkId, "fork-three");
		const proof = {
			forked,
			sent,
			modelSaw: modelInputs.at(-1),
			fork: await transcript(forkId),
			source: await transcript(sourceId),
		};
		evidence = { ...evidence, sourceId, forkId, proof };
		expect(proof).toEqual({
			forked: {
				native: expect.stringMatching(/^ses_/),
				forkedFrom: sourceId,
				rowsUnderNative: 0,
				eventsUnderNative: 0,
				shown: ["user: fork-one", "assistant: Heard fork-one."],
			},
			sent: "Heard fork-three.",
			modelSaw: ["fork-one", "fork-three"],
			fork: [
				"user: fork-one",
				"assistant: Heard fork-one.",
				"user: fork-three",
				"assistant: Heard fork-three.",
			],
			source: [
				"user: fork-one",
				"assistant: Heard fork-one.",
				"user: fork-two",
				"assistant: Heard fork-two.",
			],
		});
	});

	it("forks with files into a worktree and runs the fork there", async () => {
		evidence["name"] = "fork-with-files";
		const {
			browser,
			repo,
			sourceId,
			modelInputs,
			binding,
			transcript,
			messageOf,
			nativeSessions,
			turn,
		} = await start();
		await turn(sourceId, "fork-one");
		await turn(sourceId, "fork-two");
		const { sessionId: forkId } = await Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId: sourceId,
				originId: browser.originId,
				messageId: await messageOf(sourceId, "Heard fork-one."),
				files: true,
			}),
		);
		const bound = binding(forkId);
		const sent = await turn(forkId, "fork-three");
		const worktree = nativeSessions().find(({ id }) => id === bound.native);
		const proof = {
			bound,
			sent,
			modelSaw: modelInputs.at(-1),
			fork: await transcript(forkId),
			nativeInWorktree:
				worktree !== undefined && worktree.directory !== repo
					? git(worktree.directory, ["rev-parse", "--git-common-dir"]).trim()
					: worktree?.directory,
		};
		evidence = { ...evidence, sourceId, forkId, proof };
		expect(proof).toEqual({
			bound: {
				native: expect.not.stringMatching(new RegExp(`^${forkId}$`)),
				forkedFrom: sourceId,
				rowsUnderNative: 0,
				eventsUnderNative: 0,
			},
			sent: "Heard fork-three.",
			modelSaw: ["fork-one", "fork-three"],
			fork: [
				"user: fork-one",
				"assistant: Heard fork-one.",
				"user: fork-three",
				"assistant: Heard fork-three.",
			],
			// The native fork runs in a checkout of the project's repository, not the project folder.
			nativeInWorktree: expect.stringMatching(/\.git$/),
		});
	});

	it("leaves no session for a fork a crash cut off before its binding", async () => {
		evidence["name"] = "crash-before-bind";
		const {
			fixture,
			browser,
			sourceId,
			query,
			nativeSessions,
			messageOf,
			turn,
		} = await start("forked");
		await turn(sourceId, "fork-one");
		await turn(sourceId, "fork-two");
		const before = nativeSessions().map(({ id }) => id);
		void Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId: sourceId,
				originId: browser.originId,
				messageId: await messageOf(sourceId, "Heard fork-one."),
			}),
		).catch(() => {});
		// test-waits-allow polling: the daemon holds after OpenCode forked and tells no client; OpenCode's store is the only signal.
		await vi.waitFor(
			() => expect(nativeSessions().length).toBe(before.length + 1),
			{ timeout: 10_000 },
		);
		const orphan = nativeSessions().find(({ id }) => !before.includes(id));
		const midFork = query<{ id: string }>(
			"SELECT id FROM sessions ORDER BY id",
		);
		await fixture.kill();
		await fixture.restart();
		const reopened = await fixture.connect();
		await reopened.startInstance("managed-test");
		const proof = {
			midFork: midFork.map(({ id }) => id),
			afterRestart: query<{ id: string }>(
				"SELECT id FROM sessions ORDER BY id",
			).map(({ id }) => id),
			eventsUnderOrphan: query(
				"SELECT 1 FROM events WHERE session_id = ?",
				orphan?.id ?? "",
			).length,
		};
		evidence = { ...evidence, sourceId, orphan, proof };
		expect(proof).toEqual({
			midFork: [sourceId],
			afterRestart: [sourceId],
			eventsUnderOrphan: 0,
		});
	});

	it("sends on a fork a crash cut off after its binding", async () => {
		evidence["name"] = "crash-after-bind";
		const {
			fixture,
			sourceId,
			query,
			modelInputs,
			binding,
			messageOf,
			turn,
			browser,
		} = await start("bound");
		await turn(sourceId, "fork-one");
		await turn(sourceId, "fork-two");
		void Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId: sourceId,
				originId: browser.originId,
				messageId: await messageOf(sourceId, "Heard fork-one."),
				files: true,
			}),
		).catch(() => {});
		// test-waits-allow polling: the daemon holds after the binding and tells no client; the store is the only signal.
		await vi.waitFor(
			() =>
				expect(
					query("SELECT id FROM sessions WHERE forked_from = ?", sourceId),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const forkId =
			query<{ id: string }>(
				"SELECT id FROM sessions WHERE forked_from = ?",
				sourceId,
			)[0]?.id ?? "";
		await fixture.kill();
		await fixture.restart();
		const reopened = await fixture.connect();
		await reopened.startInstance("managed-test");
		const sent = (
			await reopened.send(forkId, "fork-three", SEND_TIMEOUT)
		).chunks.join("");
		const proof = {
			bound: binding(forkId),
			sent,
			modelSaw: modelInputs.at(-1),
		};
		evidence = { ...evidence, sourceId, forkId, proof };
		expect(proof).toEqual({
			bound: {
				native: expect.stringMatching(/^ses_/),
				forkedFrom: sourceId,
				rowsUnderNative: 0,
				eventsUnderNative: 0,
			},
			sent: "Heard fork-three.",
			modelSaw: ["fork-one", "fork-three"],
		});
	});
});

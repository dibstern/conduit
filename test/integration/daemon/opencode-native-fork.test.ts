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
	const start = async (pauseAt?: "forked" | "bound" | "rebind") => {
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
		/** The history node a message belongs to, on or off the Head. */
		const nodeOf = (messageId: string) =>
			query<{ node: string }>(
				"SELECT history_node_id AS node FROM messages WHERE id = ? UNION SELECT node_id FROM history_off_head WHERE row_key = ?",
				messageId,
				messageId,
			)[0]?.node ?? "";
		/** What a page does: preview the move, then confirm the proposal it was shown. */
		const move = async (
			intent:
				| { _tag: "rewind"; messageId: string }
				| { _tag: "switch"; nodeId: string },
		) => {
			const { moveId } = await Effect.runPromise(
				browser.rpc.PreviewHeadMove({ sessionId: sourceId, intent }),
			);
			await Effect.runPromise(
				browser.rpc.CommitHeadMove({ sessionId: sourceId, intent, moveId }),
			);
		};
		/** The OpenCode session the source runs on, and the others it has left. */
		const natives = () => {
			const [row] = query<{ value: string }>(
				"SELECT value FROM provider_state WHERE session_id = ? AND key = 'opencode.natives'",
				sourceId,
			);
			return row
				? (JSON.parse(row.value) as {
						current?: string;
						sessions: Record<string, { held: string[] }>;
					})
				: undefined;
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
			nodeOf,
			move,
			natives,
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

	// 82tn.52 slice 6 (lane-81 audit rows S1-S4, S7-S9): a branch the current OpenCode session no
	// longer holds is refused, or sends on the wrong path; switching back deletes or forks; the
	// copies OpenCode re-ids duplicate the transcript; a rewind on a fork names ids OpenCode lacks.
	it("switches to a branch its OpenCode session dropped, switches back, and forks inside a branch", async () => {
		evidence["name"] = "branch-switch";
		const {
			browser,
			sourceId,
			modelInputs,
			query,
			nativeSessions,
			transcript,
			messageOf,
			turn,
			nodeOf,
			move,
			natives,
		} = await start();
		const plan = async () =>
			(
				await Effect.runPromise(
					browser.rpc.GetResumePlan({ sessionId: sourceId }),
				)
			).plan;
		const step = async (name: string, prompt: string) => {
			const sent = await turn(sourceId, prompt);
			steps[name] = {
				sent,
				modelSaw: modelInputs.at(-1),
				shown: await transcript(sourceId),
				native: natives()?.current ?? sourceId,
				openCodeSessions: nativeSessions().length,
			};
		};
		const steps: Record<string, unknown> = {};
		for (const prompt of ["fork-one", "fork-two", "fork-three"])
			await turn(sourceId, prompt);
		const [tipA, cut] = [
			nodeOf(await messageOf(sourceId, "Heard fork-three.")),
			nodeOf(await messageOf(sourceId, "Heard fork-two.")),
		];
		// Edit at fork-two: OpenCode truncates its own session (82tn.55).
		await move({
			_tag: "rewind",
			messageId: await messageOf(sourceId, "fork-two"),
		});
		await step("edit", "fork-b");
		const tipB = nodeOf(await messageOf(sourceId, "Heard fork-b."));
		await move({ _tag: "switch", nodeId: tipA });
		steps["planOnA"] = await plan();
		await step("onA", "fork-four");
		await move({ _tag: "switch", nodeId: tipB });
		steps["planOnB"] = await plan();
		await step("backOnB", "fork-five");
		// fork-two's node is inside branch A, which the current OpenCode session never held.
		await move({ _tag: "switch", nodeId: cut });
		steps["planInA"] = await plan();
		await step("insideA", "fork-six");
		// A rewind on the fork drops rows OpenCode holds under its copies' ids.
		await move({
			_tag: "rewind",
			messageId: await messageOf(sourceId, "fork-two"),
		});
		await step("rewindOnFork", "fork-seven");
		const proof = {
			steps,
			sessions: query<{ id: string }>("SELECT id FROM sessions").map(
				({ id }) => id,
			),
			// Eight prompts, two rows each, on or off the Head: a copy OpenCode re-ids adds none.
			messageRows: query<{ n: number }>(
				"SELECT (SELECT count(*) FROM messages WHERE session_id = ?) + (SELECT count(*) FROM history_off_head WHERE session_id = ? AND source_table = 'messages') AS n",
				sourceId,
				sourceId,
			)[0]?.n,
		};
		evidence = { ...evidence, sourceId, natives: natives(), proof };
		const openCodeAtEdit = 2; // The source, and the copy taken before truncating it.
		expect(proof).toEqual({
			steps: {
				edit: {
					sent: "Heard fork-b.",
					modelSaw: ["fork-one", "fork-b"],
					shown: [
						"user: fork-one",
						"assistant: Heard fork-one.",
						"user: fork-b",
						"assistant: Heard fork-b.",
					],
					native: sourceId,
					openCodeSessions: openCodeAtEdit,
				},
				planOnA: "native",
				onA: {
					sent: "Heard fork-four.",
					modelSaw: ["fork-one", "fork-two", "fork-three", "fork-four"],
					shown: [
						"user: fork-one",
						"assistant: Heard fork-one.",
						"user: fork-two",
						"assistant: Heard fork-two.",
						"user: fork-three",
						"assistant: Heard fork-three.",
						"user: fork-four",
						"assistant: Heard fork-four.",
					],
					native: expect.not.stringMatching(sourceId),
					openCodeSessions: openCodeAtEdit,
				},
				planOnB: "native",
				backOnB: {
					sent: "Heard fork-five.",
					modelSaw: ["fork-one", "fork-b", "fork-five"],
					shown: [
						"user: fork-one",
						"assistant: Heard fork-one.",
						"user: fork-b",
						"assistant: Heard fork-b.",
						"user: fork-five",
						"assistant: Heard fork-five.",
					],
					native: sourceId,
					openCodeSessions: openCodeAtEdit,
				},
				planInA: "native",
				insideA: {
					sent: "Heard fork-six.",
					modelSaw: ["fork-one", "fork-two", "fork-six"],
					shown: [
						"user: fork-one",
						"assistant: Heard fork-one.",
						"user: fork-two",
						"assistant: Heard fork-two.",
						"user: fork-six",
						"assistant: Heard fork-six.",
					],
					native: expect.not.stringMatching(sourceId),
					openCodeSessions: openCodeAtEdit + 1,
				},
				rewindOnFork: {
					sent: "Heard fork-seven.",
					modelSaw: ["fork-one", "fork-seven"],
					shown: [
						"user: fork-one",
						"assistant: Heard fork-one.",
						"user: fork-seven",
						"assistant: Heard fork-seven.",
					],
					native: expect.not.stringMatching(sourceId),
					openCodeSessions: openCodeAtEdit + 2,
				},
			},
			sessions: [sourceId],
			messageRows: 16,
		});
	});

	// 82tn.52 slice 6 (lane-81 audit rows S6, S10): a crash between OpenCode's fork and the rebind.
	it("keeps the session on its old path when a crash cuts off a fork before its rebind", async () => {
		evidence["name"] = "crash-before-rebind";
		const {
			fixture,
			browser,
			sourceId,
			modelInputs,
			query,
			nativeSessions,
			messageOf,
			turn,
			nodeOf,
			move,
			natives,
		} = await start("rebind");
		for (const prompt of ["fork-one", "fork-two", "fork-three"])
			await turn(sourceId, prompt);
		const cut = nodeOf(await messageOf(sourceId, "Heard fork-two."));
		await move({
			_tag: "rewind",
			messageId: await messageOf(sourceId, "fork-two"),
		});
		await turn(sourceId, "fork-b");
		const beforeFork = {
			natives: natives(),
			openCode: nativeSessions().map(({ id }) => id),
		};
		await move({ _tag: "switch", nodeId: cut });
		void browser.send(sourceId, "fork-six", SEND_TIMEOUT).catch(() => {});
		// test-waits-allow polling: the daemon holds after OpenCode forked and tells no client; OpenCode's store is the only signal.
		await vi.waitFor(
			() =>
				expect(nativeSessions().length).toBe(beforeFork.openCode.length + 1),
			{ timeout: 20_000 },
		);
		const orphan = nativeSessions().find(
			({ id }) => !beforeFork.openCode.includes(id),
		)?.id;
		await fixture.kill();
		await fixture.restart();
		const reopened = await fixture.connect();
		await reopened.startInstance("managed-test");
		const afterRestart = {
			natives: natives(),
			sessions: query<{ id: string }>("SELECT id FROM sessions").map(
				({ id }) => id,
			),
			eventsUnderOrphan: query(
				"SELECT 1 FROM events WHERE session_id = ?",
				orphan ?? "",
			).length,
		};
		const sent = (
			await reopened.send(sourceId, "fork-seven", SEND_TIMEOUT)
		).chunks.join("");
		const proof = {
			afterRestart,
			sent,
			modelSaw: modelInputs.at(-1),
			boundToOrphan: natives()?.current === orphan,
		};
		evidence = { ...evidence, sourceId, orphan, beforeFork, proof };
		expect(proof).toEqual({
			afterRestart: {
				natives: beforeFork.natives,
				sessions: [sourceId],
				eventsUnderOrphan: 0,
			},
			sent: "Heard fork-seven.",
			// The outbox may or may not resend fork-six after the restart; both run on the kept path.
			modelSaw: expect.any(Array),
			boundToOrphan: false,
		});
		expect(proof.modelSaw?.slice(0, 2)).toEqual(["fork-one", "fork-two"]);
		expect(proof.modelSaw?.at(-1)).toBe("fork-seven");
	});
});

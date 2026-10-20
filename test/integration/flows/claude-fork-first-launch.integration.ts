// Failures: creation touches Claude; retries fork twice; copied cuts point at a
// never-launched transcript; inherited goals or the hidden command escape; an
// unsafe/unsupported resume loses canonical context instead of handing it off.
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { forkSession } from "../../../src/lib/domain/relay/Services/session-command.js";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { readClaudeGoalStatus } from "../../../src/lib/provider/claude/claude-goal-tracker.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { Options } from "../../../src/lib/provider/claude/types.js";
import { ProjectShellEnvResolver } from "../../../src/lib/provider/project-shell-env.js";
import {
	claudeSdk,
	type ProcessMark,
	responseChunks,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

type Launch = {
	resume: Options["resume"];
	forkSession: Options["forkSession"];
	sessionId: Options["sessionId"];
	resumeSessionAt: Options["resumeSessionAt"];
};
type TranscriptEntry = {
	type: string;
	uuid: string;
	message?: { id?: string; content?: unknown };
};

describe("Integration: Claude forks at first launch", () => {
	let root: string;
	let login: string;
	let harness: RelayHarness | undefined;
	let client: TestWsClient;
	let launches: Launch[];
	let providerForkCalls: number;
	let transcriptReads: number;
	const evidence: unknown[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-fork-first-launch-"));
		login = join(root, "login");
		mkdirSync(login);
		mkdirSync(join(root, "home"));
		writeFileSync(join(login, "conduit-test-record-forks"), "");
		writeFileSync(join(root, "proof.ndjson"), "");
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", login);
		vi.stubEnv("CONDUIT_CONFIG_DIR", root);
		vi.stubEnv("CONDUIT_TEST_PROCESS_PROOF", join(root, "proof.ndjson"));
		vi.spyOn(ProjectShellEnvResolver.prototype, "register").mockImplementation(
			() => {},
		);
		vi.spyOn(
			ProjectShellEnvResolver.prototype,
			"waitUntilReady",
		).mockResolvedValue(true);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
		launches = [];
		providerForkCalls = 0;
		transcriptReads = 0;
	});

	afterEach(async ({ task }) => {
		try {
			await harness?.stop();
		} finally {
			harness = undefined;
			evidence.push({
				name: task.name,
				get result() {
					return task.result?.state;
				},
				launches,
				providerForkCalls,
				transcriptReads,
				inputs: marks().filter((mark) => mark.kind === "enqueue"),
			});
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			__setProbeOverrideForTesting(undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});

	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/hiuf-6-claude-fork-first-launch.json",
			`${JSON.stringify({ cases: evidence }, null, 2)}\n`,
		);
	});

	function marks(): ProcessMark[] {
		return readFileSync(join(root, "proof.ndjson"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProcessMark);
	}

	function transcript(sdkId: string): TranscriptEntry[] {
		return readFileSync(
			join(login, `conduit-test-transcript-${sdkId}.ndjson`),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as TranscriptEntry);
	}

	async function start() {
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					const options = params.options;
					launches.push({
						resume: options?.resume,
						forkSession: options?.forkSession,
						sessionId: options?.sessionId,
						resumeSessionAt: options?.resumeSessionAt,
					});
					return claudeSdk.query(params);
				},
				fork: {
					...claudeSdk.fork,
					readTranscript: (id, options) => {
						transcriptReads++;
						return claudeSdk.fork.readTranscript(id, options);
					},
					forkSession: (id, options) => {
						providerForkCalls++;
						return claudeSdk.fork.forkSession(id, options);
					},
				},
			},
		});
		client = await harness.connectWsClient();
		await client.waitForInitialState();
	}

	async function send(sessionId: string, text: string) {
		client.clearReceived();
		await client.sendMessage(text, { sessionId });
		return client.waitForTurnEnd(sessionId, 10_000);
	}

	async function source(text = "Source context") {
		await start();
		const created = await client.createSession("Source", {
			instanceId: "claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "",
			},
		});
		const id = created["id"];
		if (typeof id !== "string") throw new Error("Missing Source id");
		expect((await send(id, text)).attention).not.toBe("error");
		const query = marks()
			.reverse()
			.find((mark) => mark.kind === "query");
		if (query?.kind !== "query") throw new Error("Missing Source SDK query");
		const reply = transcript(query.sessionId)
			.reverse()
			.find((entry) => entry.type === "assistant");
		if (!reply?.message?.id) throw new Error("Missing Source cut");
		return {
			id,
			sdkId: query.sessionId,
			cutId: reply.message.id,
			cutUuid: reply.uuid,
		};
	}

	async function fork(id: string, messageId?: string) {
		const created = await client.forkSession({
			sessionId: id,
			...(messageId ? { messageId } : {}),
		});
		const forkId = created["id"];
		if (typeof forkId !== "string") throw new Error("Missing Fork id");
		return forkId;
	}

	function assertNoHiddenOutput(sessionId: string, completedTurns = 1) {
		if (!harness) throw new Error("Missing relay harness");
		expect(JSON.stringify(client.getReceived())).not.toMatch(
			/\/goal clear|Goal cleared:|<command-name>|<local-command-stdout>|Unknown command: goal|I cleared your goal/,
		);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const rows = db
				.prepare("SELECT data FROM events WHERE session_id = ?")
				.all(sessionId);
			expect(JSON.stringify(rows)).not.toMatch(
				/\/goal clear|Goal cleared:|<command-name>|<local-command-stdout>|Unknown command: goal|I cleared your goal/,
			);
			const row = db
				.prepare("SELECT goal_state FROM sessions WHERE id = ?")
				.get(sessionId) as { goal_state: string | null };
			expect(
				row.goal_state === null || JSON.parse(row.goal_state).goal === null,
			).toBe(true);
			const inputs = db
				.prepare("SELECT text FROM pending_inputs WHERE session_id = ?")
				.all(sessionId);
			expect(JSON.stringify(inputs)).not.toContain("/goal clear");
			const counts = db
				.prepare(
					"SELECT type, COUNT(*) AS count FROM events WHERE session_id = ? AND type IN ('message.created', 'turn.completed') GROUP BY type",
				)
				.all(sessionId) as Array<{ type: string; count: number }>;
			expect(
				counts.find((row) => row.type === "turn.completed")?.count ?? 0,
			).toBe(completedTurns);
			expect(
				counts.find((row) => row.type === "message.created")?.count ?? 0,
			).toBe(completedTurns * 2);
		} finally {
			db.close();
		}
	}

	async function preWarm(sessionId: string) {
		if (!harness) throw new Error("Missing relay harness");
		harness.stack.orchestration.engine.bindSession(sessionId, "claude");
		await harness.stack.effectRuntime.runtime.runPromise(
			setModel(sessionId, { providerID: "claude", modelID: "sonnet" }),
		);
		client.clearReceived();
		await client.rpcCall((rpc) => rpc.PreWarmSession({ sessionId }));
	}

	it("creates a Fork and reserved Side Thread without provider work, then launches 7A under the Conduit id", async () => {
		const parent = await source();
		const before = {
			queries: launches.length,
			transcriptReads,
			providerForkCalls,
		};
		const forkId = await fork(parent.id, parent.cutId);
		if (!harness) throw new Error("Missing relay harness");
		const side = await harness.stack.effectRuntime.runtime.runPromise(
			forkSession(parent.id, {
				side: { title: "Side question", inputId: randomUUID() },
			}),
		);
		expect({
			queries: launches.length,
			transcriptReads,
			providerForkCalls,
		}).toEqual(before);
		expect(
			existsSync(join(login, `conduit-test-transcript-${forkId}.ndjson`)),
		).toBe(false);
		expect(
			existsSync(join(login, `conduit-test-transcript-${side.id}.ndjson`)),
		).toBe(false);
		expect((await send(forkId, "Continue fork")).attention).not.toBe("error");
		expect(launches.at(-1)).toEqual({
			resume: parent.sdkId,
			forkSession: true,
			sessionId: forkId,
			resumeSessionAt: parent.cutUuid,
		});
		expect(
			marks()
				.filter((mark) => mark.kind === "enqueue")
				.at(-1),
		).toMatchObject({ prompt: "Continue fork" });
		expect(providerForkCalls).toBe(0);
		const forkQuery = marks()
			.reverse()
			.find((mark) => mark.kind === "query");
		if (forkQuery?.kind !== "query") throw new Error("Missing Fork query");
		expect(
			marks()
				.filter(
					(mark) =>
						mark.kind === "enqueue" && mark.queryId === forkQuery.queryId,
				)
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : "")),
		).toEqual(["Continue fork"]);
		assertNoHiddenOutput(forkId);
	});

	it("pre-warms an active-goal Fork with only a hidden clear, then adopts it for the real turn", async () => {
		const parent = await source("fork-source-active-goal");
		const forkId = await fork(parent.id);
		await preWarm(forkId);
		expect(launches.at(-1)).toMatchObject({
			forkSession: true,
			sessionId: forkId,
		});
		const warmQueries = launches.length;
		assertNoHiddenOutput(forkId, 0);
		expect(
			marks()
				.filter((mark) => mark.kind === "enqueue")
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : "")),
		).toEqual(["fork-source-active-goal", "/goal clear"]);
		expect((await send(forkId, "Use the warmed fork")).attention).not.toBe(
			"error",
		);
		expect(launches).toHaveLength(warmQueries);
		assertNoHiddenOutput(forkId);
	});

	it("pre-warm refuses an unknown goal command once and sends canonical context through the fresh query", async () => {
		const parent = await source("fork-source-active-goal");
		const forkId = await fork(parent.id);
		writeFileSync(join(login, "conduit-test-unknown-goal"), "");
		await preWarm(forkId);
		expect(launches.filter((launch) => launch.forkSession)).toHaveLength(1);
		expect(launches.at(-1)?.resume).toBeUndefined();
		assertNoHiddenOutput(forkId, 0);
		expect(
			(await send(forkId, "Keep canonical history after warm refusal"))
				.attention,
		).not.toBe("error");
		const last = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (last?.kind !== "enqueue") throw new Error("Missing handoff input");
		expect(last.prompt).toContain("[Conduit context handoff]");
		expect(last.prompt).toContain("fork-source-active-goal");
		expect(launches.filter((launch) => launch.forkSession)).toHaveLength(1);
		assertNoHiddenOutput(forkId);
	});

	it("retries a failed active-goal pre-warm with a hidden clear on its existing transcript", async () => {
		const parent = await source("fork-source-active-goal");
		const forkId = await fork(parent.id);
		writeFileSync(join(login, "conduit-test-crash-after-init"), "");
		await expect(preWarm(forkId)).rejects.toThrow(
			"Synthetic crash immediately after system/init",
		);
		expect(
			(await send(forkId, "Send after failed goal pre-warm")).attention,
		).not.toBe("error");
		expect(launches.filter((launch) => launch.forkSession)).toHaveLength(1);
		expect(launches.at(-1)?.resume).toBe(forkId);
		const query = marks()
			.reverse()
			.find((mark) => mark.kind === "query");
		if (query?.kind !== "query")
			throw new Error("Missing pre-warm retry query");
		expect(
			marks()
				.filter(
					(mark) => mark.kind === "enqueue" && mark.queryId === query.queryId,
				)
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : "")),
		).toEqual(["/goal clear", "Send after failed goal pre-warm"]);
		assertNoHiddenOutput(forkId);
	});

	it("does not clear a Source goal set after the chosen cut", async () => {
		const parent = await source();
		expect(
			(await send(parent.id, "fork-source-active-goal")).attention,
		).not.toBe("error");
		const forkId = await fork(parent.id, parent.cutId);
		expect(
			(await send(forkId, "Question about the earlier context")).attention,
		).not.toBe("error");
		expect(launches.at(-1)).toMatchObject({
			resume: parent.sdkId,
			forkSession: true,
			sessionId: forkId,
			resumeSessionAt: parent.cutUuid,
		});
		const query = marks()
			.reverse()
			.find((mark) => mark.kind === "query");
		if (query?.kind !== "query") throw new Error("Missing Fork query");
		expect(
			marks()
				.filter(
					(mark) => mark.kind === "enqueue" && mark.queryId === query.queryId,
				)
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : "")),
		).toEqual(["Question about the earlier context"]);
		assertNoHiddenOutput(forkId);
	});

	it("hands a refused native rewind off with only the kept canonical rows", async () => {
		const parent = await source("Kept Source context");
		expect(
			(await send(parent.id, "Discard this later turn")).attention,
		).not.toBe("error");
		const discarded = transcript(parent.sdkId)
			.reverse()
			.find((entry) => entry.type === "user");
		if (!discarded) throw new Error("Missing rewind target");
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId: parent.id, messageId: discarded.uuid }),
		);
		writeFileSync(join(login, "conduit-test-resume-drops-turn"), "");
		expect(
			(await send(parent.id, "Continue the kept conversation")).attention,
		).not.toBe("error");
		const last = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (last?.kind !== "enqueue")
			throw new Error("Missing rewind handoff input");
		expect(last.prompt).toContain("[Conduit context handoff]");
		expect(last.prompt).toContain("Kept Source context");
		expect(last.prompt).not.toContain("Discard this later turn");
		expect(launches.at(-2)).toMatchObject({
			resume: parent.sdkId,
			resumeSessionAt: parent.cutUuid,
		});
		expect(launches.at(-1)?.resume).toBeUndefined();
		expect(JSON.stringify(client.getReceived())).not.toContain(
			"Resume rejected by --resume-drops-turn:",
		);
		if (!harness) throw new Error("Missing relay harness");
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'turn.error'",
					)
					.get(parent.id),
			).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it("hands off the Fork's account B conversation when returning to its original account A", async () => {
		const otherLogin = join(root, "other-login");
		mkdirSync(otherLogin);
		writeFileSync(join(otherLogin, "conduit-test-record-forks"), "");
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "claude",
						name: "Account A",
						driver: "claude",
						configDir: login,
						port: 0,
						managed: false,
					},
					{
						id: "other",
						name: "Account B",
						driver: "claude",
						configDir: otherLogin,
						port: 0,
						managed: false,
					},
				],
			},
			root,
		);
		const parent = await source();
		const forkId = await fork(parent.id);
		await client.rpcCall((rpc) =>
			rpc.ContinueSession({
				sessionId: forkId,
				instanceId: "other",
				expectedInstanceId: "claude",
			}),
		);
		expect(
			(await send(forkId, "Fork work completed on account B")).attention,
		).not.toBe("error");
		await client.rpcCall((rpc) =>
			rpc.ContinueSession({
				sessionId: forkId,
				instanceId: "claude",
				expectedInstanceId: "other",
			}),
		);
		expect(
			(await send(forkId, "Continue that Fork work on account A")).attention,
		).not.toBe("error");
		const input = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (input?.kind !== "enqueue") throw new Error("Missing account A input");
		expect(input.prompt).toContain("[Conduit context handoff]");
		expect(input.prompt).toContain("Fork work completed on account B");
		expect(input.prompt).toContain(
			responseChunks("Fork work completed on account B").join(""),
		);
		expect(launches.at(-1)?.forkSession).toBeUndefined();
	});

	it("hands off a committed inherited rewind after delivery fails before a native receipt", async () => {
		const parent = await source("Kept inherited Source turn");
		expect(
			(await send(parent.id, "Discarded inherited Source turn")).attention,
		).not.toBe("error");
		const target = transcript(parent.sdkId)
			.reverse()
			.find((entry) => entry.type === "user");
		if (!target) throw new Error("Missing inherited rewind target");
		const forkId = await fork(parent.id);
		await client.rpcCall((rpc) =>
			rpc.RewindSession({
				sessionId: forkId,
				messageId: `${target.uuid}_${forkId}`,
			}),
		);
		writeFileSync(join(root, "fail-next-initialization"), "");
		expect(
			(await send(forkId, "First replacement failed to launch")).attention,
		).toBe("error");
		if (!harness) throw new Error("Missing relay harness");
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'session.rewind_committed'",
					)
					.get(forkId),
			).toEqual({ count: 1 });
			expect(
				db
					.prepare(
						"SELECT key FROM provider_state WHERE session_id = ? AND key LIKE 'nativeThread:%'",
					)
					.all(forkId),
			).toEqual([]);
		} finally {
			db.close();
		}
		expect(
			(await send(forkId, "Retry after committed inherited rewind")).attention,
		).not.toBe("error");
		const input = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (input?.kind !== "enqueue")
			throw new Error("Missing inherited rewind retry input");
		expect(input.prompt).toContain("[Conduit context handoff]");
		expect(input.prompt).toContain("Kept inherited Source turn");
		expect(input.prompt).not.toContain("Discarded inherited Source turn");
		expect(launches.at(-1)?.forkSession).toBeUndefined();
		expect(launches.at(-1)?.resumeSessionAt).toBeUndefined();
	});

	it("continues a first Fork turn cut off by usage limits with a real continuation instruction", async () => {
		const parent = await source();
		const forkId = await fork(parent.id);
		await send(forkId, "usage-limit-before-first-receipt");
		if (!harness) throw new Error("Missing relay harness");
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT key FROM provider_state WHERE session_id = ? AND key LIKE 'nativeThread:%'",
					)
					.all(forkId),
			).toEqual([]);
		} finally {
			db.close();
		}
		client.clearReceived();
		await client.rpcCall((rpc) =>
			rpc.ContinueSession({
				sessionId: forkId,
				instanceId: "claude",
				expectedInstanceId: "claude",
			}),
		);
		expect((await client.waitForTurnEnd(forkId)).attention).not.toBe("error");
		const input = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (input?.kind !== "enqueue")
			throw new Error("Missing same-account continuation input");
		expect(input.prompt).toBe("Continue where you left off.");
		expect(input.request).toBe("Continue where you left off.");
	});

	it.each([
		"missing transcript",
		"unmappable cut",
	])("hands off canonical context when its Source has a %s", async (failure) => {
		const parent = await source();
		const forkId = await fork(parent.id, parent.cutId);
		const file = join(login, `conduit-test-transcript-${parent.sdkId}.ndjson`);
		if (failure === "missing transcript") rmSync(file);
		else
			writeFileSync(
				file,
				`${transcript(parent.sdkId)
					.map((entry) =>
						JSON.stringify({
							...entry,
							uuid: randomUUID(),
							...(entry.message
								? {
										message: {
											...entry.message,
											id: `native-only-${entry.uuid}`,
										},
									}
								: {}),
						}),
					)
					.join("\n")}\n`,
			);

		expect(
			(await send(forkId, "Use canonical Source context")).attention,
		).not.toBe("error");
		const last = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (last?.kind !== "enqueue") throw new Error("Missing handoff input");
		expect(last.prompt).toContain("[Conduit context handoff]");
		expect(last.prompt).toContain("Source context");
		expect(launches.at(-1)?.resume).toBeUndefined();
		expect(launches.at(-1)?.forkSession).toBeUndefined();
		assertNoHiddenOutput(forkId);
	});

	it.each([
		false,
		true,
	])("recovers a failed first launch without reforking, with active goal: %s", async (activeGoal) => {
		const parent = await source(
			activeGoal ? "fork-source-active-goal" : "Source context",
		);
		const forkId = await fork(parent.id);
		writeFileSync(join(login, "conduit-test-crash-after-init"), "");
		expect((await send(forkId, "Interrupted fork launch")).attention).toBe(
			"error",
		);
		expect(launches.at(-1)).toMatchObject({
			resume: parent.sdkId,
			forkSession: true,
			sessionId: forkId,
		});
		expect(
			existsSync(join(login, `conduit-test-transcript-${forkId}.ndjson`)),
		).toBe(true);
		const beforeRetry = readdirSync(login)
			.filter((name) => name.endsWith(".ndjson"))
			.sort();
		expect((await send(forkId, "Retry fork")).attention).not.toBe("error");
		expect(launches.at(-1)).toEqual({
			resume: activeGoal ? undefined : forkId,
			forkSession: undefined,
			sessionId: undefined,
			resumeSessionAt: undefined,
		});
		expect(launches.filter((launch) => launch.forkSession)).toHaveLength(1);
		if (activeGoal) {
			const query = marks()
				.reverse()
				.find((mark) => mark.kind === "query");
			if (query?.kind !== "query") throw new Error("Missing retry query");
			const retryInputs = marks()
				.filter(
					(mark) => mark.kind === "enqueue" && mark.queryId === query.queryId,
				)
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : ""));
			expect(retryInputs).toHaveLength(1);
			expect(retryInputs[0]).toContain("[Conduit context handoff]");
			expect(retryInputs[0]).toContain("Interrupted fork launch");
			expect(retryInputs[0]).toContain("fork-source-active-goal");
			expect(retryInputs[0]?.endsWith("Retry fork")).toBe(true);
			expect(
				await readClaudeGoalStatus({
					workspaceRoot: process.cwd(),
					sdkSessionId: query.sessionId,
					configDir: configuredClaudeConfigDir(login),
				}),
			).toBeUndefined();
			expect(JSON.stringify(client.getReceived())).not.toMatch(
				/\/goal clear|Goal cleared:/,
			);
		} else {
			expect(
				readdirSync(login)
					.filter((name) => name.endsWith(".ndjson"))
					.sort(),
			).toEqual(beforeRetry);
		}
	});

	it("maps a never-launched Fork's copied cut back to the nearest launched ancestor", async () => {
		const parent = await source();
		const firstId = await fork(parent.id, parent.cutId);
		const secondId = await fork(firstId, `${parent.cutId}_${firstId}`);
		const thirdId = await fork(
			secondId,
			`${parent.cutId}_${firstId}_${secondId}`,
		);
		expect(launches).toHaveLength(1);
		expect((await send(thirdId, "Nested fork request")).attention).not.toBe(
			"error",
		);
		expect(launches.at(-1)).toEqual({
			resume: parent.sdkId,
			forkSession: true,
			sessionId: thirdId,
			resumeSessionAt: parent.cutUuid,
		});
		expect(providerForkCalls).toBe(0);
	});

	it("hands off an earlier inherited cut outside a never-launched Fork's frozen receipt", async () => {
		const parent = await source("Earlier Source constraints");
		expect((await send(parent.id, "Later Source work")).attention).not.toBe(
			"error",
		);
		if (!harness) throw new Error("Missing relay harness");
		const db = new Database(harness.eventsDbPath);
		try {
			// An account's receipt can start later than records retained in its transcript.
			expect(
				db
					.prepare(
						`UPDATE provider_state SET value = json_set(value, '$.firstSequence',
							(SELECT MAX(sequence) FROM events WHERE session_id = ?
								AND type = 'message.created' AND json_extract(data, '$.role') = 'user'))
						WHERE session_id = ? AND key = 'nativeThread:claude'`,
					)
					.run(parent.id, parent.id).changes,
			).toBe(1);
		} finally {
			db.close();
		}
		const firstId = await fork(parent.id);
		const secondId = await fork(firstId, `${parent.cutId}_${firstId}`);
		expect(launches).toHaveLength(1);
		expect(
			(await send(secondId, "Continue earlier copied context")).attention,
		).not.toBe("error");
		expect(launches.at(-1)?.forkSession).toBeUndefined();
		expect(launches.at(-1)?.resumeSessionAt).toBeUndefined();
		const input = marks()
			.reverse()
			.find((mark) => mark.kind === "enqueue");
		if (input?.kind !== "enqueue") throw new Error("Missing nested Fork input");
		expect(input.prompt).toContain("[Conduit context handoff]");
		expect(input.prompt).toContain("Earlier Source constraints");
		expect(input.prompt).not.toContain("Later Source work");
		expect(providerForkCalls).toBe(0);
	});

	it.each([
		false,
		true,
	])("clears an inherited active goal before the user prompt, including an old goal beyond 64 KB: %s", async (oldGoal) => {
		const parent = await source("fork-source-active-goal");
		if (oldGoal) {
			const padding = `${JSON.stringify({ type: "progress", uuid: randomUUID(), data: "x".repeat(70 * 1024) })}\n`;
			appendFileSync(
				join(login, `conduit-test-transcript-${parent.sdkId}.ndjson`),
				padding,
			);
			const encoded = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
			appendFileSync(
				join(login, "projects", encoded, `${parent.sdkId}.jsonl`),
				padding,
			);
			const goal = await readClaudeGoalStatus({
				workspaceRoot: process.cwd(),
				sdkSessionId: parent.sdkId,
				configDir: configuredClaudeConfigDir(login),
			});
			expect(goal).toMatchObject({
				met: false,
				condition: "Finish the Source task",
			});
		}
		const forkId = await fork(parent.id);
		expect((await send(forkId, "Fork side question")).attention).not.toBe(
			"error",
		);
		const query = marks()
			.reverse()
			.find((mark) => mark.kind === "query");
		if (query?.kind !== "query") throw new Error("Missing Fork query");
		expect(
			marks()
				.filter(
					(mark) => mark.kind === "enqueue" && mark.queryId === query.queryId,
				)
				.map((mark) => (mark.kind === "enqueue" ? mark.prompt : "")),
		).toEqual(["/goal clear", "Fork side question"]);
		expect(transcript(forkId).some((entry) => entry.type === "system")).toBe(
			true,
		);
		expect(
			await readClaudeGoalStatus({
				workspaceRoot: process.cwd(),
				sdkSessionId: forkId,
				configDir: configuredClaudeConfigDir(login),
			}),
		).toMatchObject({ met: true });
		assertNoHiddenOutput(forkId);
	});

	it.each([
		"resume-drops-turn",
		"unknown-goal",
		"model-goal-reply",
	])("preserves canonical context through handoff after %s", async (refusal) => {
		const parent = await source(
			refusal === "resume-drops-turn"
				? "Source context"
				: "fork-source-active-goal",
		);
		const forkId = await fork(parent.id);
		writeFileSync(join(login, `conduit-test-${refusal}`), "");
		expect(
			(await send(forkId, "Continue with canonical context")).attention,
		).not.toBe("error");
		const inputs = marks().filter((mark) => mark.kind === "enqueue");
		expect(inputs.at(-1)).toMatchObject({
			request: "Continue with canonical context",
		});
		const last = inputs.at(-1);
		if (last?.kind !== "enqueue") throw new Error("Missing handoff input");
		expect(last.prompt).toContain("[Conduit context handoff]");
		expect(last.prompt).toContain(
			refusal === "resume-drops-turn"
				? "Source context"
				: "fork-source-active-goal",
		);
		expect(launches.at(-1)?.resume).toBeUndefined();
		expect(launches.at(-1)?.forkSession).toBeUndefined();
		assertNoHiddenOutput(forkId);
	});
});

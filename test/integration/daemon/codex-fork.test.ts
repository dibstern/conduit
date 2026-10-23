// Failure modes: a fork includes later or running native turns, inaccessible
// homes bypass digest fallback, refs vanish on replay, rewind cuts the wrong
// goal successor, undo changes native history, or a failed revert commits locally.
// A fork of a fork must retain inherited boundaries; a missing fork source must
// seed the frozen digest once, while unrelated fork errors must remain failures.
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-model-types.js";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	readCodexSessionIdentity,
	writeCodexSessionIdentity,
} from "../../../src/lib/provider/codex/codex-session-store.js";
import { renderForkDigest } from "../../../src/lib/provider/fork-digest.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";

function nativeStarts(trace: TraceRow[]) {
	return trace.flatMap(({ dir, message }) =>
		dir === "in" && message?.method === "turn/started"
			? [message.params as { threadId: string; turn: { id: string } }]
			: [],
	);
}

/** Each detached runner gets its own initialization and the recorded wire slice. */
function splitForkTrace(source: string | TraceRow[]) {
	const trace = typeof source === "string" ? fixtureRows(source) : source;
	const firstTurn = trace.findIndex(
		({ message }) => message?.method === "turn/start",
	);
	const forkIndex = trace.findIndex(
		({ message }, index) =>
			index > firstTurn && message?.method === "thread/fork",
	);
	const threadIndex = trace.findIndex(
		({ message }) =>
			message?.method === "thread/start" || message?.method === "thread/fork",
	);
	const parentThread = nativeStarts(trace)[0]?.threadId;
	if (!parentThread || forkIndex < 0)
		throw new Error("Missing native fork recording");
	const exit = trace.filter(({ dir }) => dir === "exit");
	return {
		parent: [
			...trace.slice(0, forkIndex),
			...trace
				.slice(forkIndex)
				.filter(
					({ dir, message }) =>
						dir === "in" && message?.params?.["threadId"] === parentThread,
				),
			...exit,
		],
		child: [
			...trace.slice(0, threadIndex),
			...trace
				.slice(forkIndex)
				.filter(
					({ dir, message }) =>
						(dir === "out" && message?.method === "thread/fork") ||
						message?.params?.["threadId"] !== parentThread,
				),
		],
	};
}

describe("Codex native forks and conversation rewind through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let tracePath = "";
	let capturePath = "";
	let reportPath = "";
	let artifactRoot = "";
	let gatePath = "";
	let mapPath = "";
	let discoveryPath = "";
	const captureFiles: string[] = [];
	const sessions = new Set<string>();

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row).replaceAll("/workspace", harness?.projectDir ?? "/workspace")).join("\n")}\n`,
		);
		const capture = join(artifactRoot, `wire-${captureFiles.length}.jsonl`);
		writeFileSync(capture, "");
		captureFiles.push(capture);
		writeFileSync(
			mapPath,
			JSON.stringify({
				"*": {
					"codex-discovery": { trace: discoveryPath },
					"codex-turn": { trace: tracePath, capture },
				},
			}),
		);
	}
	const requests = (method: string) =>
		captureFiles
			.flatMap((path) => rows<TraceRow>(path))
			.filter(({ dir, message }) => dir === "out" && message?.method === method)
			.map(({ message }) => message?.params);

	async function start(name: string) {
		artifactRoot = resolve(`test-results/codex-fork/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		capturePath = join(artifactRoot, "capture.jsonl");
		reportPath = join(artifactRoot, "trace-report.jsonl");
		writeFileSync(capturePath, "");
		writeFileSync(reportPath, "");
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			logLevel: "warn",
			relaySettings: {
				harnessDefaults: {
					codex: { providerId: "codex", modelId: MODEL, contextWindow: "" },
				},
			},
		});
		const fixture = harness;
		tracePath = join(fixture.root, "codex-replay.jsonl");
		mapPath = join(fixture.root, "trace-map.json");
		discoveryPath = join(fixture.root, "discovery.jsonl");
		writeFileSync(
			discoveryPath,
			`${signedInCodexDiscoveryTrace()
				.map((row) =>
					JSON.stringify(row).replaceAll("/workspace", fixture.projectDir),
				)
				.join("\n")}\n`,
		);
		gatePath = join(fixture.root, "codex-gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeTrace(signedInCodexDiscoveryTrace());
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_TEST_CODEX_TRACE_MAP: mapPath,
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
			},
		};
		await fixture.restart(restartOptions);
		const browser = await fixture.connect();
		const account = await vi.waitFor(
			async () => {
				const account = (await browser.instances()).instances.find(
					({ driver }) => driver === "codex",
				);
				expect(account).toBeDefined();
				if (!account) throw new Error("Missing Codex account");
				return account;
			},
			{ timeout: TIMEOUT },
		);
		// Turn launches use the account's resolved environment, not the service env.
		await fixture.requestRpc({
			_tag: "UpdateInstance",
			instanceId: account.id,
			env: {
				NODE_ENV: "test",
				CONDUIT_TEST_CODEX_TRACE_MAP: mapPath,
			},
		});
		expect(await codexModels(browser, account.id)).toContainEqual(
			expect.objectContaining({ id: MODEL }),
		);
		const id = await browser.createSession(name, account.id, "codex", {
			modelId: MODEL,
			contextWindow: "",
			permissionMode: "ask",
		});
		sessions.add(id);
		return { fixture, browser, id, accountId: account.id, restartOptions };
	}

	async function settled(fixture: ProcessHarness, id: string, count: number) {
		await vi.waitFor(
			() => expect(snapshot(fixture, id).turns).toHaveLength(count),
			{ timeout: TIMEOUT },
		);
		await vi.waitFor(
			() => {
				const db = new Database(fixture.daemonStorePath(), { readonly: true });
				try {
					expect(
						db
							.prepare<[string], { count: number }>(
								"SELECT count(*) AS count FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' AND status IN ('pending', 'running')",
							)
							.get(id)?.count,
					).toBe(0);
				} finally {
					db.close();
				}
			},
			{ timeout: TIMEOUT },
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, id).turns.every(
						({ state }) => state === "completed",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
	}

	async function fork(
		fixture: ProcessHarness,
		browser: ProcessBrowser,
		id: string,
		messageId?: string,
		instanceId?: string,
	) {
		const result = await fixture.requestRpc({
			_tag: "ForkSession",
			originId: browser.originId,
			sessionId: id,
			...(messageId ? { messageId } : {}),
			...(instanceId ? { instanceId } : {}),
		});
		if (!result.sessionId) throw new Error("Missing fork session id");
		sessions.add(result.sessionId);
		return result.sessionId;
	}

	function persisted(fixture: ProcessHarness, id: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare<[string], { pending_rewind_message_id: string | null }>(
					"SELECT pending_rewind_message_id FROM sessions WHERE id = ?",
				)
				.get(id);
		} finally {
			db.close();
		}
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const state = Object.fromEntries(
			[...sessions].map((id) => [id, snapshot(fixture, id)]),
		);
		try {
			await fixture.dispose();
			writeFileSync(
				capturePath,
				captureFiles
					.flatMap((path) => rows<TraceRow>(path))
					.map((row) => JSON.stringify(row))
					.join("\n"),
			);
			const reports = rows<AppServerTraceReport>(reportPath);
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ result: task.result?.state, state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessions.clear();
			captureFiles.length = 0;
		}
	});

	it(
		"forks at the selected native turn and retains refs after daemon restart",
		async () => {
			const { fixture, browser, id, restartOptions } =
				await start("native-restart");
			const trace = splitForkTrace("fork-native");
			writeTrace(trace.parent);
			await browser.send(id, "Say hello", TIMEOUT);
			await browser.send(id, "Say hello again", TIMEOUT);
			await settled(fixture, id, 2);
			const history = await browser.history(id);
			const point = history.find(({ role }) => role === "assistant");
			if (!point) throw new Error("Missing first assistant");
			const native = nativeStarts(trace.parent);
			const refs = snapshot(fixture, id).events.filter(
				({ type, metadata }) =>
					type === "message.created" && metadata["providerRefs"],
			);
			for (const message of history)
				expect(refs).toContainEqual(
					expect.objectContaining({
						data: expect.objectContaining({ messageId: message.id }),
						metadata: expect.objectContaining({
							providerRefs: expect.objectContaining({
								providerTurnId: expect.any(String),
							}),
						}),
					}),
				);
			writeTrace(signedInCodexDiscoveryTrace());
			await fixture.kill();
			await fixture.restart(restartOptions);
			const reconnected = await fixture.connect(id);
			expect(
				snapshot(fixture, id).events.filter(
					({ type, metadata }) =>
						type === "message.created" && metadata["providerRefs"],
				),
			).toEqual(refs);
			const child = await fork(fixture, reconnected, id, point.id);
			writeTrace(trace.child);
			await reconnected.send(child, "What do you remember?", TIMEOUT);
			await settled(fixture, child, 2);
			expect(requests("thread/fork")).toEqual([
				expect.objectContaining({
					threadId: native[0]?.threadId,
					lastTurnId: native[0]?.turn.id,
				}),
			]);
			expect(requests("turn/start").at(-1)?.["threadId"]).not.toBe(
				native[0]?.threadId,
			);
			expect(requests("turn/start").at(-1)?.["input"]).toEqual([
				{ type: "text", text: "What do you remember?", text_elements: [] },
			]);
			expect(
				readCodexSessionIdentity(fixture.configDir, child)?.forkSource,
			).toBeUndefined();
		},
		TIMEOUT,
	);

	it(
		"forks a fork at an inherited native turn on its current thread",
		async () => {
			const { fixture, browser, id } = await start("fork-of-fork");
			const a = splitForkTrace("fork-of-fork");
			const b = splitForkTrace(a.child);
			writeTrace(a.parent);
			await browser.send(id, "Say hello", TIMEOUT);
			await settled(fixture, id, 1);
			const child = await fork(fixture, browser, id);
			writeTrace(b.parent);
			await browser.send(child, "Only on B", TIMEOUT);
			await settled(fixture, child, 2);
			const inherited = (await browser.history(child)).find(
				({ role }) => role === "assistant",
			);
			if (!inherited) throw new Error("Missing inherited assistant");
			const grandchild = await fork(fixture, browser, child, inherited.id);
			const first = nativeStarts(a.parent)[0];
			const onB = nativeStarts(b.parent)[0];
			expect(
				readCodexSessionIdentity(fixture.configDir, grandchild)?.forkSource,
			).toEqual({
				threadId: onB?.threadId,
				lastTurnId: first?.turn.id,
			});
			writeTrace(b.child);
			await browser.send(grandchild, "What do you remember?", TIMEOUT);
			await settled(fixture, grandchild, 2);
			expect(requests("thread/fork")).toEqual([
				expect.objectContaining({
					threadId: first?.threadId,
					lastTurnId: first?.turn.id,
				}),
				expect.objectContaining({
					threadId: onB?.threadId,
					lastTurnId: first?.turn.id,
				}),
			]);
			expect(requests("turn/start").at(-1)?.["threadId"]).toBe(
				nativeStarts(b.child)[0]?.threadId,
			);
			expect(requests("turn/start").at(-1)?.["input"]).toEqual([
				{ type: "text", text: "What do you remember?", text_elements: [] },
			]);
		},
		TIMEOUT,
	);

	for (const failure of [
		"missing-rollout",
		"missing-turn",
		"shared-home-move",
		"unshared-home-move",
		"unrelated-error",
	] as const)
		it(
			`handles a native fork ${failure} at first launch`,
			async () => {
				const { fixture, browser, id } = await start(`native-${failure}`);
				const trace = splitForkTrace("fork-native-missing-source");
				writeTrace(trace.parent);
				await browser.send(id, "Say hello", TIMEOUT);
				await browser.send(id, "Say hello again", TIMEOUT);
				await settled(fixture, id, 2);
				const point = (await browser.history(id)).find(
					({ role }) => role === "assistant",
				);
				if (!point) throw new Error("Missing first assistant");
				const child = await fork(fixture, browser, id, point.id);
				const identity = readCodexSessionIdentity(fixture.configDir, child);
				const digest = identity?.resumeFallbackDigest;
				expect(digest).toContain("[Historical user]\nSay hello");
				expect(digest).toContain("Hello from the mock model.");
				expect(digest).not.toContain("Say hello again");
				expect(digest?.length).toBeLessThanOrEqual(32_000);
				expect(identity?.forkSeedPending).toBe(false);
				if (
					failure === "shared-home-move" ||
					failure === "unshared-home-move"
				) {
					if (!identity?.codexHome) throw new Error("Missing Codex home");
					const previousHome = join(fixture.root, "previous-codex-home");
					mkdirSync(previousHome, { recursive: true });
					if (failure === "shared-home-move") {
						mkdirSync(join(identity.codexHome, "sessions"), {
							recursive: true,
						});
						symlinkSync(
							join(identity.codexHome, "sessions"),
							join(previousHome, "sessions"),
							"dir",
						);
					} else mkdirSync(join(previousHome, "sessions"));
					writeCodexSessionIdentity(fixture.configDir, child, {
						...identity,
						codexHome: previousHome,
					});
				}
				const failures = trace.child.filter(
					({ message }) => message?.method === "thread/fork",
				);
				const discarded =
					failures[failure === "missing-turn" ? 0 : 1]?.message?.id;
				if (discarded === undefined)
					throw new Error("Missing captured fork attempt");
				trace.child = trace.child.filter(
					({ message }) => message?.id !== discarded,
				);
				const request = trace.child.find(
					({ message }) => message?.method === "thread/fork",
				);
				if (!request?.message?.params || !identity?.forkSource)
					throw new Error("Missing native source");
				Object.assign(request.message.params, identity.forkSource);
				const responseIndex = trace.child.findIndex(
					({ dir, message }) =>
						dir === "in" && message?.id === request.message?.id,
				);
				const response = trace.child[responseIndex]?.message;
				if (!response?.error) throw new Error("Missing captured fork failure");
				if (failure === "unrelated-error")
					response.error = {
						code: -32603,
						message: "thread/fork permission missing",
					};
				if (failure === "unrelated-error") {
					writeTrace([
						...trace.child.slice(0, responseIndex + 1),
						...trace.child.filter(({ dir }) => dir === "exit"),
					]);
				} else {
					const turn = trace.child.find(
						({ message }) => message?.method === "turn/start",
					);
					if (!turn?.message?.params) throw new Error("Missing fallback turn");
					turn.message.params["input"] = [
						{ type: "text", text: digest, text_elements: [] },
						{ type: "text", text: "What do you remember?", text_elements: [] },
					];
					const next = fixtureRows("two-turns");
					const nextStart = next.reduce(
						(last, row, index) =>
							row.message?.method === "turn/start" ? index : last,
						-1,
					);
					const nextThread = nativeStarts(next)[0]?.threadId;
					const fallbackThread = nativeStarts(trace.child)[0]?.threadId;
					if (!nextThread || !fallbackThread || nextStart < 0)
						throw new Error("Missing follow-up turn");
					trace.child = [
						...trace.child.filter(({ dir }) => dir !== "exit"),
						...(JSON.parse(
							JSON.stringify(next.slice(nextStart)).replaceAll(
								nextThread,
								fallbackThread,
							),
						) as TraceRow[]),
					];
					writeTrace(trace.child);
				}
				await browser.send(child, "What do you remember?", TIMEOUT);
				expect(requests("thread/fork")).toHaveLength(1);
				if (failure === "unrelated-error") {
					expect(requests("thread/start")).toHaveLength(1);
					expect(requests("turn/start")).toHaveLength(2);
					expect(snapshot(fixture, child).events).toContainEqual(
						expect.objectContaining({
							type: "turn.error",
							data: expect.objectContaining({
								error: expect.stringContaining("Could not fork Codex thread"),
							}),
						}),
					);
					expect(
						readCodexSessionIdentity(fixture.configDir, child)?.forkSource,
					).toEqual(identity.forkSource);
				} else {
					await settled(fixture, child, 2);
					expect(requests("thread/start")).toHaveLength(2);
					expect(requests("turn/start").at(-1)?.["input"]).toEqual([
						{ type: "text", text: digest, text_elements: [] },
						{ type: "text", text: "What do you remember?", text_elements: [] },
					]);
					const saved = readCodexSessionIdentity(fixture.configDir, child);
					expect(saved?.continuationKind).toBe("transcript-digest");
					expect(saved?.forkSource).toBeUndefined();
					expect(saved?.resumeFallbackDigest).toBeUndefined();
					expect(saved?.forkSeedPending).not.toBe(true);
					expect(saved?.inheritedThreadIds).toBeUndefined();
					expect(saved?.threadId).toBe(nativeStarts(trace.child)[0]?.threadId);
					expect(snapshot(fixture, child).events).toContainEqual(
						expect.objectContaining({
							type: "session.handoff_delivered",
							data: expect.objectContaining({
								continuationKind: "transcript-digest",
							}),
						}),
					);
					await browser.send(child, "Say hello again", TIMEOUT);
					await settled(fixture, child, 3);
					expect(requests("thread/fork")).toHaveLength(1);
					expect(requests("thread/start")).toHaveLength(2);
					expect(requests("turn/start").at(-1)?.["input"]).toEqual([
						{ type: "text", text: "Say hello again", text_elements: [] },
					]);
				}
			},
			TIMEOUT,
		);

	it(
		"forks through the previous completed turn while the parent runs",
		async () => {
			const { fixture, browser, id } = await start("in-progress");
			const trace = splitForkTrace("fork-in-progress");
			writeTrace(trace.parent);
			await browser.send(id, "Say hello", TIMEOUT);
			await settled(fixture, id, 1);
			const second = trace.parent.findIndex(
				({ message }) =>
					message?.method === "turn/start" &&
					JSON.stringify(message.params).includes("Say hello again"),
			);
			const delta = trace.parent
				.slice(second)
				.find(({ message }) => message?.method === "item/agentMessage/delta");
			if (typeof delta?.["at"] !== "number")
				throw new Error("Missing second turn delta");
			writeFileSync(gatePath, String(delta["at"]));
			const sending = browser.send(id, "Say hello again", TIMEOUT);
			await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(2), {
				timeout: TIMEOUT,
			});
			await vi.waitFor(
				() =>
					expect(
						snapshot(fixture, id).events.some(
							({ metadata }) =>
								(
									metadata["providerRefs"] as
										| { providerTurnId?: string }
										| undefined
								)?.providerTurnId === nativeStarts(trace.parent)[1]?.turn.id,
						),
					).toBe(true),
				{ timeout: TIMEOUT },
			);
			expect(snapshot(fixture, id).turns.at(-1)?.state).toBe("running");
			const messages = await browser.history(id);
			const running = messages.filter(({ role }) => role === "user").at(-1);
			if (!running) throw new Error("Missing running user");
			const child = await fork(fixture, browser, id, running.id);
			writeTrace(trace.child);
			const reply = browser.send(child, "What do you remember?", TIMEOUT);
			await vi.waitFor(() => expect(requests("thread/fork")).toHaveLength(1), {
				timeout: TIMEOUT,
			});
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await Promise.all([sending, reply]);
			expect(requests("thread/fork")[0]?.["lastTurnId"]).toBe(
				nativeStarts(trace.parent)[0]?.turn.id,
			);
		},
		TIMEOUT,
	);

	for (const fallback of [
		"no-native-ref",
		"no-native-thread",
		"other-provider",
		"unshared-home",
	] as const)
		it(
			`uses the digest for ${fallback}`,
			async () => {
				const { fixture, browser, id, accountId } = await start(fallback);
				const parentId =
					fallback === "other-provider"
						? await browser.createSession("Claude parent")
						: id;
				sessions.add(parentId);
				if (parentId === id) {
					const basic = fixtureRows("basic");
					writeTrace(basic);
					await browser.send(id, "Say hello", TIMEOUT);
					await settled(fixture, id, 1);
					if (fallback === "no-native-ref") {
						const db = new Database(fixture.daemonStorePath());
						try {
							db.prepare(
								"UPDATE events SET metadata = json_remove(metadata, '$.providerRefs') WHERE session_id = ?",
							).run(id);
						} finally {
							db.close();
						}
					} else {
						const identityPath = join(
							fixture.configDir,
							"codex",
							"stores",
							id,
							"session.json",
						);
						if (fallback === "no-native-thread") unlinkSync(identityPath);
						else {
							const identity = JSON.parse(
								readFileSync(identityPath, "utf8"),
							) as Record<string, unknown>;
							identity["codexHome"] = join(fixture.root, "unshared-codex-home");
							writeFileSync(identityPath, JSON.stringify(identity));
						}
					}
				} else await browser.send(parentId, "Say hello", TIMEOUT);
				const child = await fork(
					fixture,
					browser,
					parentId,
					undefined,
					accountId,
				);
				const seed = fixtureRows("fork-seed");
				const store = new Database(fixture.daemonStorePath(), {
					readonly: true,
				});
				const history = store
					.prepare<[string], MessageWithParts>(
						"SELECT * FROM messages WHERE session_id = ? AND is_inherited = 1 ORDER BY created_at, rowid",
					)
					.all(child);
				for (const message of history)
					message.parts = store
						.prepare<[string], MessagePartRow>(
							"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
						)
						.all(message.id);
				store.close();
				expect(history.length).toBeGreaterThan(0);
				const first = seed.find(
					({ message }) => message?.method === "turn/start",
				);
				const input = first?.message?.params?.["input"] as {
					type: string;
					text: string;
				}[];
				if (!input[0]) throw new Error("Missing seed input");
				input[0].text = renderForkDigest(history);
				writeTrace(seed);
				await browser.send(child, "Say hello", TIMEOUT);
				await browser.send(child, "Say hello again", TIMEOUT);
				expect(requests("thread/fork")).toEqual([]);
				expect(
					JSON.stringify(requests("turn/start").at(-2)?.["input"]),
				).toContain("[Conduit fork context]");
			},
			TIMEOUT,
		);

	it(
		"uses the last native goal turn for a fork and the first for rewind",
		async () => {
			const { fixture, browser, id } = await start("goal-native-boundaries");
			const goal = fixtureRows("goal-chain");
			const native = nativeStarts(goal);
			const first = native[0];
			const last = native.at(-1);
			if (!first || !last) throw new Error("Missing native goal turns");
			const rewind = fixtureRows("rewind-start-over");
			const revertIndex = rewind.findIndex(
				({ message }) => message?.method === "thread/revert",
			);
			const before = rewind[revertIndex]?.message?.params;
			const tail = JSON.parse(
				JSON.stringify(rewind.slice(revertIndex))
					.replaceAll(String(before?.["threadId"]), first.threadId)
					.replaceAll(String(before?.["beforeTurnId"]), first.turn.id),
			) as TraceRow[];
			writeTrace([...goal.filter(({ dir }) => dir !== "exit"), ...tail]);
			await browser.send(id, "/goal Say hello", TIMEOUT);
			await settled(fixture, id, 1);
			const history = await browser.history(id);
			for (const message of history) {
				const ids = new Set(
					snapshot(fixture, id)
						.events.filter(
							({ type, data }) =>
								type === "message.created" && data["messageId"] === message.id,
						)
						.map(
							({ metadata }) =>
								(
									metadata["providerRefs"] as
										| { providerTurnId?: string }
										| undefined
								)?.providerTurnId,
						)
						.filter(Boolean),
				);
				expect([...ids]).toEqual(native.map(({ turn }) => turn.id));
			}
			const child = await fork(fixture, browser, id);
			const trace = splitForkTrace("fork-native").child;
			const source = trace.find(
				({ message }) => message?.method === "thread/fork",
			)?.message?.params;
			writeTrace(
				JSON.parse(
					JSON.stringify(trace)
						.replaceAll(String(source?.["threadId"]), first.threadId)
						.replaceAll(String(source?.["lastTurnId"]), last.turn.id),
				) as TraceRow[],
			);
			await browser.send(child, "What do you remember?", TIMEOUT);
			expect(requests("thread/fork")[0]?.["lastTurnId"]).toBe(last.turn.id);
			const target = history.find(({ role }) => role === "user");
			if (!target) throw new Error("Missing goal prompt");
			await Effect.runPromise(
				browser.rpc.RewindSession({ sessionId: id, messageId: target.id }),
			);
			await browser.send(id, "Continue after rewind", TIMEOUT);
			expect(requests("thread/revert")[0]?.["beforeTurnId"]).toBe(
				first.turn.id,
			);
		},
		TIMEOUT,
	);

	for (const scenario of [
		"rewind-revert",
		"rewind-start-over",
		"rewind-before-native",
		"rewind-revert-failed",
		"undo",
	] as const)
		it(
			scenario,
			async () => {
				const { fixture, browser, id } = await start(scenario);
				const trace = fixtureRows(
					scenario === "undo"
						? "rewind-revert"
						: scenario === "rewind-before-native"
							? "rewind-start-over"
							: scenario,
				);
				const native = nativeStarts(trace);
				if (
					scenario === "rewind-revert-failed" ||
					scenario === "rewind-before-native"
				) {
					const request = trace.find(
						({ message }) => message?.method === "thread/revert",
					);
					if (request?.message?.params)
						request.message.params["beforeTurnId"] = native[1]?.turn.id;
				}
				if (scenario === "undo") {
					const request = trace.find(
						({ message }) => message?.method === "thread/revert",
					);
					const id = request?.message?.id;
					writeTrace(
						trace.filter(
							({ message }) =>
								message?.id !== id && message?.method !== "thread/reverted",
						),
					);
				} else writeTrace(trace);
				for (const text of [
					"Say hello",
					"Say hello again",
					"Say hello a third time",
				])
					await browser.send(id, text, TIMEOUT);
				await settled(fixture, id, 3);
				const history = await browser.history(id);
				const users = history.filter(({ role }) => role === "user");
				if (scenario === "rewind-before-native") {
					const db = new Database(fixture.daemonStorePath());
					try {
						db.prepare(
							"UPDATE events SET metadata = json_remove(metadata, '$.providerRefs') WHERE session_id = ? AND json_extract(metadata, '$.correlationId') = ?",
						).run(id, users[0]?.id);
					} finally {
						db.close();
					}
				}
				const target =
					users[
						scenario === "rewind-start-over" ||
						scenario === "rewind-before-native"
							? 0
							: 1
					];
				if (!target) throw new Error("Missing rewind target");
				await Effect.runPromise(
					browser.rpc.RewindSession({ sessionId: id, messageId: target.id }),
				);
				expect(requests("thread/revert")).toEqual([]);
				if (scenario === "undo")
					await Effect.runPromise(browser.rpc.UndoRewind({ sessionId: id }));
				if (scenario === "rewind-revert-failed") {
					const inputId = randomUUID();
					await fixture.requestRpc({
						_tag: "input.submit",
						sessionId: id,
						inputId,
						delivery: "queue",
						text: "Continue after rewind",
					});
					// A failed revert has no placed input to advance shell completion.
					await vi.waitFor(
						() => {
							const { events } = snapshot(fixture, id);
							const requested = events.find(
								({ type, data }) =>
									type === "run.requested" && data["inputId"] === inputId,
							);
							expect(requested).toBeDefined();
							expect(events).toContainEqual(
								expect.objectContaining({
									type: "turn.error",
									metadata: expect.objectContaining({
										runId: requested?.data["runId"],
									}),
									data: expect.objectContaining({
										error: expect.stringContaining(
											"Codex conversation rewind failed",
										),
									}),
								}),
							);
							expect(
								events.filter(
									({ type, data }) =>
										type === "message.created" && data["messageId"] === inputId,
								),
							).toEqual([]);
						},
						{ timeout: TIMEOUT },
					);
					expect(persisted(fixture, id)?.pending_rewind_message_id).toBe(
						target.id,
					);
					expect(requests("turn/start")).toHaveLength(3);
				} else {
					await browser.send(id, "Continue after rewind", TIMEOUT);
					expect(persisted(fixture, id)?.pending_rewind_message_id).toBeNull();
					expect(requests("thread/revert")).toEqual(
						scenario === "undo"
							? []
							: [
									expect.objectContaining({
										threadId: native[0]?.threadId,
										beforeTurnId:
											native[scenario === "rewind-start-over" ? 0 : 1]?.turn.id,
									}),
								],
					);
					expect(requests("turn/start").at(-1)?.["threadId"]).toBe(
						native[0]?.threadId,
					);
				}
			},
			TIMEOUT,
		);
});

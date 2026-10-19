import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

type Browser = Awaited<ReturnType<ProcessHarness["connect"]>>;
type PromptRow = {
	id: string;
	session_id: string;
	type: string;
	status: string;
	provider_process_id: string | null;
	provider_request_id: string | null;
	decision: string | null;
	session_status: string;
};

function rows(harness: ProcessHarness): PromptRow[] {
	const filename = harness.daemonStorePath();
	if (!existsSync(filename)) return [];
	const db = new Database(filename, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT pa.id, pa.session_id, pa.type, pa.status, pa.provider_process_id, pa.provider_request_id, pa.decision, s.status AS session_status FROM pending_approvals pa JOIN sessions s ON s.id = pa.session_id ORDER BY s.created_at, s.rowid, pa.created_at, pa.rowid",
			)
			.all() as PromptRow[];
	} finally {
		db.close();
	}
}

function answers(harness: ProcessHarness) {
	const filename = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(filename)) return [];
	return readFileSync(filename, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((mark) => mark["kind"] === "prompt-answer");
}

function mutateStore(
	harness: ProcessHarness,
	change: (db: Database.Database) => void,
) {
	const db = new Database(harness.daemonStorePath());
	try {
		change(db);
	} finally {
		db.close();
	}
}

function resolutions(harness: ProcessHarness, id: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<[string], { type: string; data: string }>(
				"SELECT type, data FROM events WHERE type IN ('permission.resolved', 'question.resolved') AND json_extract(data, '$.id') = ? ORDER BY sequence",
			)
			.all(id)
			.map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as Record<string, unknown>,
			}));
	} finally {
		db.close();
	}
}

function inboxState(harness: ProcessHarness) {
	if (!existsSync(harness.daemonStorePath())) return [];
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<
				[],
				{
					session_id: string;
					status: string;
					prompts: number;
					queued: number;
					turn: string | null;
					in_flight: number;
				}
			>(`SELECT s.id AS session_id, s.status,
			(SELECT COUNT(*) FROM pending_approvals WHERE session_id = s.id AND status = 'pending') AS prompts,
			(SELECT COUNT(*) FROM pending_inputs WHERE session_id = s.id AND state = 'queued') AS queued,
			(SELECT state FROM turns WHERE session_id = s.id ORDER BY requested_at DESC, rowid DESC LIMIT 1) AS turn,
			(SELECT COUNT(*) FROM provider_command_outbox WHERE session_id = s.id AND status IN ('pending', 'running', 'retryable_failed')) AS in_flight
			FROM sessions s ORDER BY s.created_at, s.rowid`)
			.all();
	} finally {
		db.close();
	}
}

const openCodePrompt = (
	type: "permission" | "question",
	id: string,
	sessionID: string,
) => ({
	id,
	sessionID,
	...(type === "permission"
		? {
				permission: "bash",
				patterns: ["echo identity"],
				metadata: {},
				always: [],
			}
		: {
				questions: [
					{
						question: "Continue?",
						header: "Identity",
						options: [{ label: "Continue" }],
					},
				],
			}),
});

async function answer(browser: Browser, row: PromptRow) {
	if (row.type === "permission")
		await browser.answerApproval({ requestId: row.id }, "allow");
	else
		await Effect.runPromise(
			browser.rpc.AnswerQuestion({
				projectSlug: "process-test",
				originId: browser.originId,
				commandId: randomUUID(),
				toolId: row.id,
				answers: { "0": "Continue" },
			}),
		);
}

async function pending(harness: ProcessHarness, sessionId: string, count = 1) {
	await vi.waitFor(
		() =>
			expect(
				rows(harness).filter(
					(row) => row.session_id === sessionId && row.status === "pending",
				),
			).toHaveLength(count),
		{ timeout: 30_000 },
	);
	const row = rows(harness).find(
		(row) => row.session_id === sessionId && row.status === "pending",
	);
	if (!row) throw new Error("Missing pending prompt");
	expect(row.id).not.toBe("0");
	expect(row.provider_request_id).toBe("0");
	expect(row.provider_process_id).toEqual(expect.any(String));
	return row;
}

describe("Conduit prompt identity through the daemon and Claude runner", () => {
	let harness: ProcessHarness;
	let artifact = "";
	afterEach(async () => {
		if (!harness) return;
		try {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn26-${artifact}.diagnostics.json`,
				JSON.stringify(
					{ ...harness.proof(), inbox: inboxState(harness) },
					null,
					2,
				),
			);
			const ids = new Map<string, string>();
			const normalize = (kind: string, value: string) => {
				const key = `${kind}:${value}`;
				if (!ids.has(key))
					ids.set(
						key,
						`${kind}-${[...ids.keys()].filter((id) => id.startsWith(`${kind}:`)).length + 1}`,
					);
				return ids.get(key);
			};
			writeFileSync(
				`test-results/82tn26-${artifact}.json`,
				`${JSON.stringify(
					{
						prompts: rows(harness).map((row) => ({
							...row,
							id: normalize("prompt", row.id),
							session_id: normalize("session", row.session_id),
							provider_process_id:
								row.provider_process_id &&
								normalize("process", row.provider_process_id),
						})),
						answers: answers(harness).map(({ pid, ...mark }) => ({
							...mark,
							pid: normalize("pid", String(pid)),
						})),
						openCodeAnswers: harness
							.opencodeRequestBodies()
							.filter(
								({ method, path }) =>
									method === "POST" && /\/(permissions?|question)\//.test(path),
							)
							.map(({ method, path, body }) => ({
								method,
								path: path.replace(
									/\/session\/([^/]+)/,
									(_match, id: string) =>
										`/session/${normalize("session", id)}`,
								),
								body: JSON.parse(body) as unknown,
							})),
					},
					null,
					2,
				)}\n`,
			);
			if (
				artifact.endsWith("-reconnect") &&
				existsSync(harness.daemonStorePath())
			) {
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					await db.backup(`test-results/82tn26-${artifact}.db`);
				} finally {
					db.close();
				}
			}
		} finally {
			await harness.dispose();
		}
	});

	it("loads legacy OpenCode prompts once after upgrade and answers their original ids", async () => {
		artifact = "legacy-opencode-upgrade";
		harness = ProcessHarness.create({
			dist: "dist",
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		await harness.restart({ startupTimeoutMs: 60_000 });
		const browser = await harness.connect();
		const session = await browser.createSession(
			"Legacy prompts",
			"opencode",
			"opencode",
		);
		for (const type of ["permission", "question"] as const) {
			await harness.addOpenCodePrompt(
				type,
				harness.projectDir,
				openCodePrompt(type, `${type}-legacy`, session),
			);
		}
		await vi.waitFor(() => expect(rows(harness)).toHaveLength(2));
		await harness.kill();
		// Recreate the persisted pre-migration format in this isolated fixture.
		mutateStore(harness, (db) => {
			for (const row of rows(harness)) {
				db.prepare(
					"UPDATE events SET data = json_remove(json_set(data, '$.id', ?), '$.providerProcessId', '$.providerRequestId') WHERE type = ? AND json_extract(data, '$.id') = ?",
				).run(row.provider_request_id, `${row.type}.asked`, row.id);
				db.prepare(
					"UPDATE pending_approvals SET id = ?, provider_process_id = NULL, provider_request_id = NULL WHERE id = ?",
				).run(row.provider_request_id, row.id);
			}
		});
		await harness.restart({ startupTimeoutMs: 60_000 });
		const recovered = await harness.connect(session);
		// A live barrier follows the connect-time permission/question reconciliation.
		await harness.emitOpenCodeEvent({
			directory: realpathSync(harness.projectDir),
			payload: {
				type: "session.status",
				properties: { sessionID: session, status: { type: "idle" } },
			},
		});
		for (const type of ["permission", "question"] as const) {
			await recovered.waitFor(
				(frame) =>
					frame["type"] === `${type}_pending` &&
					(frame["requestId"] ?? frame["toolId"]) === `${type}-legacy`,
			);
		}
		expect(rows(harness)).toHaveLength(2);
		for (const row of rows(harness)) await answer(recovered, row);
		await vi.waitFor(() =>
			expect(rows(harness).map(({ status }) => status)).toEqual([
				"resolved",
				"resolved",
			]),
		);
		for (const type of ["permission", "question"] as const) {
			expect(
				harness
					.opencodeRequests()
					.some(
						({ method, url }) =>
							method === "POST" &&
							url.includes(
								`/${type === "permission" ? "permissions" : "question"}/${type}-legacy`,
							),
					),
			).toBe(true);
		}
	}, 150_000);

	it("expires answers to stopped OpenCode prompts and retires the rest on replacement", async () => {
		artifact = "opencode-expiry";
		harness = ProcessHarness.create({
			dist: "dist",
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		await harness.restart({ startupTimeoutMs: 60_000 });
		const browser = await harness.connect();
		const session = await browser.createSession(
			"Expired prompts",
			"opencode",
			"opencode",
		);
		for (const [type, id] of [
			["permission", "stopped-permission"],
			["question", "stopped-question"],
			["permission", "replaced-permission"],
			["question", "replaced-question"],
		] as const) {
			await harness.addOpenCodePrompt(
				type,
				harness.projectDir,
				openCodePrompt(type, id, session),
			);
		}
		await vi.waitFor(() => expect(rows(harness)).toHaveLength(4));
		await harness.setOpenCodeStatus(harness.projectDir, session, {
			type: "busy",
		});
		await vi.waitFor(() =>
			expect(rows(harness)[0]?.session_status).toBe("busy"),
		);
		await browser.stopInstance("opencode");
		// This replacement has no surviving provider-side prompts or work. The
		// fake normally retains those snapshots to test daemon reconnection.
		writeFileSync(
			join(harness.configDir, "fake-opencode-state.json"),
			JSON.stringify({
				statuses: {},
				permissions: {},
				questions: {},
				drops: [],
			}),
		);
		for (const row of rows(harness).filter(({ provider_request_id }) =>
			provider_request_id?.startsWith("stopped-"),
		)) {
			await expect(answer(browser, row)).rejects.toThrow(/expired/i);
			expect(rows(harness).find(({ id }) => id === row.id)?.status).toBe(
				"resolved",
			);
			expect(resolutions(harness, row.id)).toHaveLength(1);
		}
		void browser
			.send(session, "after OpenCode replacement", 60_000)
			.catch(() => undefined);
		await vi.waitFor(() =>
			mutateStore(harness, (db) =>
				expect(
					db
						.prepare(
							"SELECT state FROM pending_inputs WHERE session_id = ? AND state = 'queued'",
						)
						.all(session),
				).toHaveLength(1),
			),
		);
		await browser.startInstance("opencode");
		await vi.waitFor(
			() =>
				expect(rows(harness).every(({ status }) => status === "resolved")).toBe(
					true,
				),
			{ timeout: 15_000 },
		);
		await vi.waitFor(() =>
			expect(rows(harness)[0]?.session_status).toBe("idle"),
		);
		await vi.waitFor(
			() =>
				expect(
					harness
						.opencodeRequests()
						.some(
							({ method, url }) =>
								method === "POST" &&
								url.split("?")[0] === `/session/${session}/prompt_async`,
						),
				).toBe(true),
			{ timeout: 30_000 },
		);
		await vi.waitFor(() =>
			expect(inboxState(harness)[0]).toMatchObject({
				status: "idle",
				queued: 0,
				prompts: 0,
			}),
		);
		expect(
			harness
				.opencodeRequests()
				.filter(
					({ method, url }) =>
						method === "POST" && /\/(permissions?|question)\//.test(url),
				),
		).toHaveLength(0);
		for (const row of rows(harness)) {
			await expect(answer(browser, row)).rejects.toThrow(/expired/i);
			expect(resolutions(harness, row.id)).toEqual([
				expect.objectContaining({
					type: `${row.type}.resolved`,
					data: expect.objectContaining(
						row.type === "permission"
							? { decision: "reject" }
							: { answers: {} },
					),
				}),
			]);
		}
	}, 150_000);

	for (const kind of ["approval", "question"] as const) {
		it.each([
			"live",
			"recovered",
		] as const)(`${kind}: a failed ask write cancels its %s waiter`, async (mode) => {
			artifact = `${kind}-failed-write-${mode}`;
			harness = ProcessHarness.create({
				dist: "dist",
				restartProof: true,
				...(mode === "recovered"
					? {
							holdRunnerOutput:
								kind === "approval" ? "permission-request" : "question-request",
						}
					: {}),
			});
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			let browser = await harness.connect();
			const session = await browser.createSession("Failed prompt write");
			const failWrites = () =>
				mutateStore(harness, (db) =>
					db.exec(
						"CREATE TRIGGER fail_prompt_write BEFORE INSERT ON pending_approvals BEGIN SELECT RAISE(ABORT, 'injected prompt write failure'); END",
					),
				);
			if (mode === "live") failWrites();
			const turn = browser
				.send(session, `${kind}-fixed-failed-write`, 60_000)
				.catch(() => undefined);
			if (mode === "recovered") {
				await vi.waitFor(
					() =>
						expect(
							readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8"),
						).toContain('"kind":"held-output"'),
					{ timeout: 30_000 },
				);
				await harness.kill();
				await turn;
				failWrites();
				await harness.restart({
					startupTimeoutMs: 60_000,
					runnerStartupTimeoutMs: 30_000,
				});
				browser = await harness.connect(session);
			}
			await vi.waitFor(() => expect(answers(harness)).toHaveLength(1), {
				timeout: 30_000,
			});
			expect(answers(harness)[0]).toMatchObject({
				requestId: "0",
				response: { behavior: "deny" },
			});
			await turn;
			expect(rows(harness)).toEqual([]);
			expect(harness.logTail).toMatch(
				/Failed to record (permission|question)\.asked/,
			);
			await vi.waitFor(
				() =>
					expect(inboxState(harness)[0]).toMatchObject({
						status: "idle",
						prompts: 0,
						turn: "completed",
					}),
				{ timeout: 15_000 },
			);
			mutateStore(harness, (db) => db.exec("DROP TRIGGER fail_prompt_write"));
			await browser.send(session, "after failed write", 60_000);
		}, 150_000);

		it(`${kind}: retires a lost runner's prompt when its replacement attaches`, async () => {
			artifact = `${kind}-pending-replacement`;
			harness = ProcessHarness.create({ dist: "dist", restartProof: true });
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const browser = await harness.connect();
			const session = await browser.createSession("Lost runner prompt");
			const turn = browser
				.send(session, `${kind}-fixed-lost`, 60_000)
				.catch(() => undefined);
			const before = await pending(harness, session);
			const runner = harness.marks.find(
				(mark) => mark.kind === "runner-started" && mark.sessionId === session,
			);
			if (runner?.kind !== "runner-started") throw new Error("Missing runner");
			await harness.kill();
			await turn;
			process.kill(runner.pid, "SIGKILL");
			await vi.waitFor(() =>
				expect(() => process.kill(runner.pid, 0)).toThrow(),
			);
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const recovered = await harness.connect(session);
			await recovered.preWarmSession(session, 60_000);
			await vi.waitFor(
				() =>
					expect(rows(harness).find(({ id }) => id === before.id)?.status).toBe(
						"resolved",
					),
				{ timeout: 15_000 },
			);
			expect(resolutions(harness, before.id)).toEqual([
				expect.objectContaining({
					type: `${before.type}.resolved`,
					data: expect.objectContaining(
						kind === "approval" ? { decision: "reject" } : { answers: {} },
					),
				}),
			]);
			expect(answers(harness)).toEqual([]);
			await recovered.send(session, "after runner replacement", 60_000);
			expect(rows(harness)[0]?.session_status).toBe("idle");
		}, 150_000);

		it(`${kind}: isolates the same provider request id across sessions`, async () => {
			artifact = `${kind}-sessions`;
			harness = ProcessHarness.create({
				dist: "dist",
				restartProof: true,
			});
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const a = await harness.connect();
			const b = await harness.connect();
			const first = await a.createSession("First prompt");
			const second = await b.createSession("Second prompt");
			const firstTurn = a.send(first, `${kind}-fixed-first`, 60_000);
			// A failure in an assertion must not leave an unhandled send rejection.
			void firstTurn.catch(() => undefined);
			const one = await pending(harness, first);
			const secondTurn = b.send(second, `${kind}-fixed-second`, 60_000);
			void secondTurn.catch(() => undefined);
			const two = await pending(harness, second);
			expect(one.id).not.toBe(two.id);
			await a.waitFor(
				(frame) =>
					frame["type"] ===
						`${kind === "approval" ? "permission" : kind}_pending` &&
					(frame["requestId"] ?? frame["toolId"]) === one.id,
			);
			await b.waitFor(
				(frame) =>
					frame["type"] ===
						`${kind === "approval" ? "permission" : kind}_pending` &&
					(frame["requestId"] ?? frame["toolId"]) === two.id,
			);
			await answer(a, one);
			await firstTurn;
			expect(rows(harness).find((row) => row.id === one.id)?.status).toBe(
				"resolved",
			);
			expect(rows(harness).find((row) => row.id === two.id)).toMatchObject({
				status: "pending",
				session_status: "busy",
			});
			expect(answers(harness).map((mark) => mark["prompt"])).toEqual([
				`${kind}-fixed-first`,
			]);
			await answer(b, two);
			await secondTurn;
			expect(rows(harness).map((row) => row.status)).toEqual([
				"resolved",
				"resolved",
			]);
			expect(answers(harness).map((mark) => mark["requestId"])).toEqual([
				"0",
				"0",
			]);
		}, 150_000);

		it(`${kind}: opens a new prompt after its provider runner is replaced`, async () => {
			artifact = `${kind}-replacement`;
			harness = ProcessHarness.create({
				dist: "dist",
				restartProof: true,
			});
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const browser = await harness.connect();
			const session = await browser.createSession("Runner replacement");
			const turn = browser.send(session, `${kind}-fixed-before`, 60_000);
			void turn.catch(() => undefined);
			const before = await pending(harness, session);
			await answer(browser, before);
			await turn;
			const runner = harness.marks.find(
				(mark) => mark.kind === "runner-started" && mark.sessionId === session,
			);
			if (runner?.kind !== "runner-started") throw new Error("Missing runner");
			process.kill(runner.pid, "SIGKILL");
			await vi.waitFor(() =>
				expect(() => process.kill(runner.pid, 0)).toThrow(),
			);
			const next = browser.send(session, `${kind}-fixed-after`, 60_000);
			void next.catch(() => undefined);
			const after = await pending(harness, session);
			expect(after.id).not.toBe(before.id);
			expect(after.provider_process_id).not.toBe(before.provider_process_id);
			await answer(browser, after);
			await next;
			expect(rows(harness)).toHaveLength(2);
			expect(answers(harness).map((mark) => mark["requestId"])).toEqual([
				"0",
				"0",
			]);
		}, 150_000);

		it(`${kind}: redelivers once when the daemon reconnects to a retained runner`, async () => {
			artifact = `${kind}-reconnect`;
			harness = ProcessHarness.create({
				dist: "dist",
				restartProof: true,
			});
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const browser = await harness.connect();
			const session = await browser.createSession("Runner reconnect");
			const peer = await harness.connect();
			const peerSession = await peer.createSession("Peer runner reconnect");
			const turn = browser
				.send(session, `${kind}-fixed-reconnect`, 60_000)
				.catch(() => undefined);
			const before = await pending(harness, session);
			const peerTurn = peer
				.send(peerSession, `${kind}-fixed-peer`, 60_000)
				.catch(() => undefined);
			const peerBefore = await pending(harness, peerSession);
			await harness.kill();
			await Promise.all([turn, peerTurn]);
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const recovered = await harness.connect(session);
			const after = await pending(harness, session);
			expect(after).toEqual(before);
			expect(await pending(harness, peerSession)).toEqual(peerBefore);
			await answer(recovered, after);
			await recovered.waitForTurnEnd(session);
			expect(
				rows(harness).find((row) => row.id === peerBefore.id)?.status,
			).toBe("pending");
			expect(answers(harness).map((mark) => mark["requestId"])).toEqual(["0"]);
			const recoveredPeer = await harness.connect(peerSession);
			await answer(recoveredPeer, peerBefore);
			await recoveredPeer.waitForTurnEnd(peerSession);
			expect(rows(harness)).toHaveLength(2);
			expect(answers(harness).map((mark) => mark["requestId"])).toEqual([
				"0",
				"0",
			]);
		}, 150_000);
	}
});

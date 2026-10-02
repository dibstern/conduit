import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../../src/lib/utils.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function snapshot(harness: ProcessHarness, sessionId: string) {
	const db = new Database(join(harness.projectDir, ".conduit/events.db"), {
		readonly: true,
	});
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId),
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId),
			commands: db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			approvals: db
				.prepare(
					"SELECT id, type, status, decision FROM pending_approvals WHERE session_id = ?",
				)
				.all(sessionId),
			events: (
				db
					.prepare(
						"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as Array<{ type: string; data: string }>
			).map((event) => ({ ...event, data: JSON.parse(event.data) as unknown })),
		};
	} finally {
		db.close();
	}
}

function started(harness: ProcessHarness) {
	const runner = harness.marks
		.filter((mark) => mark.kind === "runner-started")
		.at(-1);
	if (runner?.kind !== "runner-started")
		throw new Error("Missing runner proof");
	return runner;
}

describe("built-dist Claude runner lifecycle", () => {
	const fixtures: Array<{ harness: ProcessHarness; sessionId?: string }> = [];
	afterEach(async (context) => {
		const evidence = fixtures.map(({ harness, sessionId }) => ({
			proof: harness.proof(),
			...(sessionId ? snapshot(harness, sessionId) : {}),
		}));
		for (const { harness } of fixtures) await harness.dispose();
		const runnerCleanup = fixtures.flatMap(({ harness }) =>
			[
				...new Set(
					harness.marks.flatMap((mark) =>
						mark.kind === "runner-spawned" || mark.kind === "runner-started"
							? [mark.pid]
							: [],
					),
				),
			].map((pid) => {
				let exited = false;
				try {
					process.kill(pid, 0);
				} catch (cause) {
					exited = isRecord(cause) && cause["code"] === "ESRCH";
				}
				expect(exited).toBe(true);
				return { pid, exited };
			}),
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/85kb-10-${context.task.name.replace(/\W+/g, "-")}.json`,
			JSON.stringify(
				{ result: context.task.result?.state, evidence, runnerCleanup },
				null,
				2,
			),
		);
		fixtures.length = 0;
	});

	async function start(
		runnerLifecycle?: NonNullable<
			Parameters<typeof ProcessHarness.start>[0]
		>["runnerLifecycle"],
	) {
		expect(existsSync("dist/src/bin/claude-session-runner.js")).toBe(true);
		const harness = await ProcessHarness.start({
			dist: resolve("dist"),
			claudeRunner: "process",
			...(runnerLifecycle ? { runnerLifecycle } : {}),
		});
		const fixture: { harness: ProcessHarness; sessionId?: string } = {
			harness,
		};
		fixtures.push(fixture);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Runner lifecycle");
		fixture.sessionId = sessionId;
		return { harness, browser, sessionId };
	}

	it("exits after the idle window, resets it on activity, and respawns on send", async () => {
		const idleTimeoutMs = 1200;
		const { harness, browser, sessionId } = await start({ idleTimeoutMs });
		await browser.send(sessionId, "idle-first");
		const first = started(harness);
		await new Promise<void>((done) => setTimeout(done, 700));
		await browser.send(sessionId, "ambient-idle");
		expect(started(harness).pid).toBe(first.pid);
		await new Promise<void>((done) => setTimeout(done, 700));
		expect(() => process.kill(first.pid, 0)).not.toThrow();
		await vi.waitFor(
			() => {
				expect(() => process.kill(first.pid, 0)).toThrow();
				expect(existsSync(first.socketPath)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(
			snapshot(harness, sessionId).events.some(
				(event) => event.type === "turn.error",
			),
		).toBe(false);
		const next = await browser.send(sessionId, "idle-restart");
		expect(next.chunks).toEqual(responseChunks("idle-restart"));
		expect(next.done["code"]).toBe(0);
		expect(started(harness).pid).not.toBe(first.pid);
		await vi.waitFor(() =>
			expect(snapshot(harness, sessionId).commands).toEqual([
				{ status: "completed" },
				{ status: "completed" },
				{ status: "completed" },
			]),
		);
	}, 30_000);

	it("releases end-session admission when interrupted before runner readiness", async () => {
		const { harness, browser, sessionId } = await start({ helloDelayMs: 3000 });
		const first = browser.send(sessionId, "before-interrupted-end");
		await vi.waitFor(
			() =>
				expect(
					harness.marks.some((mark) => mark.kind === "runner-hello-pending"),
				).toBe(true),
			{ timeout: 5000 },
		);
		const controller = new AbortController();
		const reload = browser.reloadSession(sessionId, controller.signal).then(
			() => "completed",
			() => "interrupted",
		);
		await vi.waitFor(() =>
			expect(
				harness.marks.some((mark) => mark.kind === "runner-end-selected"),
			).toBe(true),
		);
		controller.abort();
		expect(await reload).toBe("interrupted");
		expect((await first).done["code"]).toBe(0);
		const runner = started(harness);
		const next = await browser.send(sessionId, "after-interrupted-end");
		expect(next.done["code"]).toBe(0);
		expect(next.chunks).toEqual(responseChunks("after-interrupted-end"));
		expect(started(harness).pid).toBe(runner.pid);
		await vi.waitFor(() =>
			expect(snapshot(harness, sessionId).commands).toEqual([
				{ status: "completed" },
				{ status: "completed" },
			]),
		);
	}, 40_000);

	it("respawns transparently for a send racing idle exit admission", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: 300,
			idleExitDelayMs: 1000,
		});
		await browser.send(sessionId, "before-idle-race");
		const first = started(harness);
		await vi.waitFor(
			() =>
				expect(
					harness.marks.some(
						(mark) =>
							mark.kind === "runner-idle-exit-started" &&
							mark.pid === first.pid,
					),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(existsSync(first.socketPath)).toBe(true);
		const cursor = browser.frames.length;
		const turn = browser.send(sessionId, "approval-idle-race");
		void turn.catch(() => {});
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			cursor,
		);
		expect(started(harness).pid).not.toBe(first.pid);
		await browser.answerApproval(approval, "allow");
		expect((await turn).done["code"]).toBe(0);
		await vi.waitFor(() =>
			expect(snapshot(harness, sessionId).commands).toEqual([
				{ status: "completed" },
				{ status: "completed" },
			]),
		);
		expect(
			browser.frames
				.slice(cursor)
				.some(({ message }) => message["type"] === "error"),
		).toBe(false);
		expect(
			snapshot(harness, sessionId).events.some(
				(event) => event.type === "turn.error",
			),
		).toBe(false);
	}, 35_000);

	it("uses the active daemon config directory for idle policy and sockets", async () => {
		const { harness, browser, sessionId } = await start({
			nonDefaultConfigDir: true,
			idleDayMs: 100,
		});
		const activeDir = join(harness.root, "active-config");
		const path = join(activeDir, "daemon.json");
		await browser.setAutoSettle(null);
		await vi.waitFor(() =>
			expect(
				(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[
					"autoSettleAfterDays"
				],
			).toBe(null),
		);
		const config = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		writeFileSync(
			join(harness.root, "config", "daemon.json"),
			JSON.stringify({ ...config, autoSettleAfterDays: 1 }),
		);
		await browser.send(sessionId, "active-config-idle");
		const first = started(harness);
		expect(first.socketPath.startsWith(`${join(activeDir, "r")}/`)).toBe(true);
		await new Promise<void>((done) => setTimeout(done, 500));
		expect(() => process.kill(first.pid, 0)).not.toThrow();
		await browser.setAutoSettle(1);
		await vi.waitFor(
			() => {
				expect(() => process.kill(first.pid, 0)).toThrow();
				expect(existsSync(first.socketPath)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(
			(await browser.send(sessionId, "active-config-restart")).done["code"],
		).toBe(0);
		expect(started(harness).pid).not.toBe(first.pid);
	}, 35_000);

	it("keeps a pending approval alive beyond the idle window", async () => {
		const { harness, browser, sessionId } = await start({ idleTimeoutMs: 100 });
		const pending = browser.send(sessionId, "approval-idle");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_request",
		);
		const runner = started(harness);
		await new Promise<void>((done) => setTimeout(done, 400));
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		await browser.answerApproval(request, "allow");
		expect((await pending).done["code"]).toBe(0);
		await vi.waitFor(() =>
			expect(snapshot(harness, sessionId).session).toEqual({ status: "idle" }),
		);
	}, 30_000);

	it("honors a disabled idle policy", async () => {
		const { harness, browser, sessionId } = await start({
			idleTimeoutMs: null,
		});
		await browser.send(sessionId, "idle-disabled");
		const runner = started(harness);
		await new Promise<void>((done) => setTimeout(done, 400));
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
	}, 30_000);

	it.each([
		"stall",
		"approval",
		"question",
	])("persists a crash during %s and clears replayed interactions", async (phase) => {
		const { harness, browser, sessionId } = await start();
		const pending = browser.send(sessionId, `${phase}-crash`);
		await browser.waitFor(
			(message) =>
				message["type"] ===
				(phase === "approval"
					? "permission_request"
					: phase === "question"
						? "ask_user"
						: "delta"),
		);
		const runner = started(harness);
		process.kill(runner.pid, "SIGKILL");
		expect((await pending).done["code"]).toBe(1);
		await browser.waitFor(
			(message) =>
				message["type"] === "error" && message["sessionId"] === sessionId,
		);
		await vi.waitFor(
			() => {
				const state = snapshot(harness, sessionId);
				expect(state.session).toEqual({ status: "idle" });
				expect(state.turns).toEqual([{ state: "error" }]);
				expect(state.commands).toEqual([{ status: "failed" }]);
				expect(
					state.events.filter((event) => event.type === "turn.error"),
				).toHaveLength(1);
				expect(state.approvals).toHaveLength(phase === "stall" ? 0 : 1);
				for (const approval of state.approvals)
					expect(approval).toMatchObject({ status: "resolved" });
			},
			{ timeout: 5000 },
		);
		await browser.close();
		const reconnect = await harness.connect(sessionId);
		await reconnect.view(sessionId);
		const recovered = await reconnect.send(sessionId, "after-crash");
		expect(recovered.done["code"]).toBe(0);
		expect(recovered.chunks).toEqual(responseChunks("after-crash"));
		expect(started(harness).pid).not.toBe(runner.pid);
		await vi.waitFor(() =>
			expect(snapshot(harness, sessionId).session).toEqual({ status: "idle" }),
		);
		expect(
			reconnect.frames.some(
				({ message }) =>
					message["type"] === "permission_request" ||
					message["type"] === "ask_user",
			),
		).toBe(false);
	}, 30_000);

	it.each([
		"crash",
		"reload",
	])("finishes %s cleanup before starting a replacement turn", async (phase) => {
		const { harness, browser, sessionId } = await start({
			failureCleanupDelayMs: 5000,
		});
		const failed = browser.send(sessionId, "approval-overlap-crash");
		await browser.waitFor(
			(message) => message["type"] === "permission_request",
		);
		if (phase === "crash") {
			process.kill(started(harness).pid, "SIGKILL");
			await vi.waitFor(() =>
				expect(JSON.stringify(harness.proof())).toContain(
					"Claude runner failed",
				),
			);
		} else await browser.reloadSession(sessionId);
		const cursor = browser.frames.length;
		const replacement = browser.send(sessionId, "approval-overlap-recovery");
		await browser.waitFor(
			(message) =>
				message["type"] === "user_message" &&
				message["text"] === "approval-overlap-recovery",
			cursor,
		);
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			cursor,
		);
		await failed;
		const active = snapshot(harness, sessionId);
		expect(active.session).toEqual({ status: "busy" });
		expect(
			active.approvals.filter(
				(approval) => isRecord(approval) && approval["status"] === "pending",
			),
		).toHaveLength(1);
		await browser.answerApproval(approval, "allow");
		await browser.waitFor(
			(message) => message["type"] === "done" && message["code"] === 0,
			cursor,
		);
		await replacement;
		await vi.waitFor(() => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([
				{
					state:
						phase === "crash"
							? "error"
							: expect.stringMatching(/^(completed|interrupted)$/),
				},
				{ state: "completed" },
			]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "completed" },
			]);
			for (const approval of state.approvals)
				expect(approval).toMatchObject({ status: "resolved" });
		});
	}, 35_000);

	it.each([
		"server",
		"runner",
	])("refuses the %s protocol version and shows the session error", async (side) => {
		const { harness, browser, sessionId } = await start(
			side === "server"
				? { serverProtocolVersion: 999 }
				: { runnerHelloProtocolVersion: 999 },
		);
		const turn = await browser.send(sessionId, "protocol-refusal");
		expect(turn.done["code"]).toBe(1);
		const error = await browser.waitFor(
			(message) =>
				message["type"] === "error" && message["code"] === "provider_error",
		);
		expect(error["message"]).toMatch(/protocol.*mismatch.*999/i);
		await vi.waitFor(() => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }]);
			expect(state.commands).toEqual([{ status: "failed" }]);
			expect(
				state.events.some(
					(event) =>
						event.type === "turn.error" &&
						isRecord(event.data) &&
						/protocol.*mismatch/i.test(String(event.data["error"])),
				),
			).toBe(true);
			expect(JSON.stringify(harness.proof())).toMatch(
				/protocol.*mismatch.*999/i,
			);
		});
		expect(harness.marks.some((mark) => mark.kind === "query")).toBe(false);
	}, 30_000);

	it("fails every queued turn when startup refuses the protocol", async () => {
		const { harness, browser, sessionId } = await start({
			serverProtocolVersion: 999,
		});
		const turns = await Promise.all([
			browser.send(sessionId, "protocol-queued-first"),
			browser.send(sessionId, "protocol-queued-second"),
		]);
		for (const turn of turns) expect(turn.done["code"]).toBe(1);
		await vi.waitFor(() => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }, { state: "error" }]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "failed" },
			]);
			expect(
				state.events.filter((event) => event.type === "turn.error"),
			).toHaveLength(2);
		});
	}, 30_000);

	it("persists adapter failures for every queued turn without duplicate errors", async () => {
		const { harness, browser, sessionId } = await start();
		const first = browser.send(sessionId, "approval-failure-queued-first");
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_request",
		);
		const second = browser.send(sessionId, "stall-queued-second");
		await vi.waitFor(() =>
			expect(
				harness.marks.filter(
					(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
				),
			).toHaveLength(2),
		);
		await browser.answerApproval(approval, "allow");
		await Promise.all([first, second]);
		await vi.waitFor(() => {
			const state = snapshot(harness, sessionId);
			expect(state.session).toEqual({ status: "idle" });
			expect(state.turns).toEqual([{ state: "error" }, { state: "error" }]);
			expect(state.commands).toEqual([
				{ status: "failed" },
				{ status: "failed" },
			]);
			expect(
				state.events.filter((event) => event.type === "turn.error"),
			).toHaveLength(2);
		});
	}, 30_000);
});

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: an idle OpenCode never stopping, or stopping while a session
// is busy or a prompt is pending; an idle stop leaving supervisor or descendant
// processes or an open stream; background polling restarting it; a missed busy
// event letting it stop, or a missed idle event keeping it up forever; a busy
// survivor spawning twice across a restart, or outliving `conduit stop`.
describe("Managed OpenCode stops when idle", () => {
	const instanceId = defaultInstanceIdForDriver("opencode");
	const graceMs = 3_000;
	// Two grace periods, which is also more than two status poll intervals.
	const pastGraceMs = 2 * graceMs + 1_000;
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.8", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		await harness.restart({ opencodeIdleTimeoutMs: graceMs });
		return harness;
	}

	const sleep = (ms: number) =>
		new Promise<void>((done) => setTimeout(done, ms));

	/** Every fake OpenCode the daemon started: server, its child, and the supervisor. */
	function spawned(fixture: ProcessHarness) {
		const file = join(fixture.configDir, "fake-opencode-pids.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								pid: number;
								childPid: number;
								groupPid: number;
							},
					)
			: [];
	}

	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const livePids = (fixture: ProcessHarness) =>
		spawned(fixture)
			.flatMap(({ pid, childPid, groupPid }) => [pid, childPid, groupPid])
			.filter(alive);

	/** Stream connections opened without a logged close. */
	function openStreams(fixture: ProcessHarness) {
		const connections = fixture.opencodeStreamConnections();
		return connections.filter(
			({ action, pid, connectionId }) =>
				action === "open" &&
				!connections.some(
					(other) =>
						other.action === "close" &&
						other.pid === pid &&
						other.connectionId === connectionId,
				),
		);
	}

	const status = async (
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	) => (await browser.instanceStatus(instanceId)).instance?.status;

	/** Waits for the idle stop and returns a snapshot of what it left behind. */
	async function idleStopped(
		fixture: ProcessHarness,
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	) {
		await vi.waitFor(() => expect(livePids(fixture)).toEqual([]), {
			timeout: 30_000,
			interval: 250,
		});
		return {
			at: Date.now(),
			livePids: livePids(fixture),
			openStreams: openStreams(fixture),
			status: await status(browser),
			spawned: spawned(fixture).length,
		};
	}

	/** Asserts the instance is still up a full grace (and poll) window later. */
	async function keptRunning(
		fixture: ProcessHarness,
		browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	) {
		await sleep(pastGraceMs);
		const snapshot = {
			spawned: spawned(fixture).length,
			livePids: livePids(fixture).length,
			status: await status(browser),
		};
		expect(snapshot).toEqual({ spawned: 1, livePids: 3, status: "healthy" });
		return snapshot;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["spawned"] = spawned(fixture);
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["droppedEvents"] = fixture.opencodeDroppedEvents();
			evidence["requests"] = fixture.opencodeRequests();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/pa3r-8-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("stops without leftovers, stays stopped while attached, and restarts on the next action", async () => {
		const fixture = await start("idle-stop");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Idle",
			instanceId,
			"opencode",
		);
		const stopped = await idleStopped(fixture, browser);
		evidence["stopped"] = stopped;
		expect(stopped).toMatchObject({
			livePids: [],
			openStreams: [],
			status: "stopped",
			spawned: 1,
		});

		// The browser stays attached and sends nothing: polling must not restart it.
		await sleep(pastGraceMs);
		const quiet = {
			spawned: spawned(fixture).length,
			livePids: livePids(fixture),
			status: await status(browser),
		};
		evidence["attachedAfterStop"] = quiet;
		expect(quiet).toEqual({ spawned: 1, livePids: [], status: "stopped" });

		// This fixture emits session status updates without a stored turn terminal.
		const cursor = browser.frames.length;
		const accepted = await Effect.runPromise(
			browser.rpc.SendMessage({
				projectSlug: "process-test",
				sessionId,
				text: "hello",
				commandId: randomUUID(),
				originId: browser.originId,
			}),
		);
		expect(accepted).toEqual({ ok: true, sessionId });
		const busy = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "busy",
			cursor,
		);
		const idle = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "idle",
			browser.frames.findIndex(({ message }) => message === busy) + 1,
		);
		const restarted = {
			accepted,
			busy,
			idle,
			spawned: spawned(fixture).length,
			status: await status(browser),
		};
		evidence["restarted"] = restarted;
		expect(restarted.idle["status"]).toBe("idle");
		expect(restarted.spawned).toBe(2);
		expect(restarted.status).toBe("healthy");
	}, 120_000);

	it("is held up by a busy session, a pending permission and a pending question, each on its own", async () => {
		const fixture = await start("blockers");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Blockers",
			instanceId,
			"opencode",
		);
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		evidence["busy"] = await keptRunning(fixture, browser);

		await fixture.addOpenCodePrompt("permission", fixture.projectDir, {
			id: "pa8-permission",
			sessionID: sessionId,
			permission: "bash",
			patterns: ["echo idle"],
			metadata: {},
			always: [],
		});
		const permission = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === "pa8-permission",
		);
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "idle",
		});
		evidence["permission"] = await keptRunning(fixture, browser);

		await fixture.addOpenCodePrompt("question", fixture.projectDir, {
			id: "pa8-question",
			sessionID: sessionId,
			questions: [
				{
					question: "Proceed?",
					header: "Proceed",
					options: [{ label: "Yes" }],
				},
			],
		});
		const question = await browser.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				message["toolId"] === "pa8-question",
		);
		await browser.answerApproval(permission, "allow");
		evidence["question"] = await keptRunning(fixture, browser);

		await browser.rejectQuestion(question);
		const stopped = await idleStopped(fixture, browser);
		evidence["stopped"] = stopped;
		expect(stopped).toMatchObject({
			livePids: [],
			openStreams: [],
			spawned: 1,
		});
	}, 180_000);

	it("keeps running through a dropped busy event and stops late after a dropped idle event", async () => {
		const fixture = await start("dropped-events");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Dropped",
			instanceId,
			"opencode",
		);
		await fixture.dropOpenCodeEvents([
			{ type: "session.status", status: "busy" },
		]);
		const busyAt = Date.now();
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		evidence["droppedBusy"] = await keptRunning(fixture, browser);
		// Only the grace expiry's reconcile could have seen the busy session.
		const statusReads = fixture
			.opencodeRequests()
			.filter(
				({ method, url, at }) =>
					method === "GET" &&
					url.split("?")[0] === "/session/status" &&
					at > busyAt + graceMs,
			);
		expect(statusReads.length).toBeGreaterThan(0);

		await fixture.dropOpenCodeEvents([
			{ type: "session.status", status: "idle" },
		]);
		const idleAt = Date.now();
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "idle",
		});
		const stopped = await idleStopped(fixture, browser);
		evidence["droppedIdle"] = { ...stopped, stopAfterMs: stopped.at - idleAt };
		expect(stopped).toMatchObject({
			livePids: [],
			openStreams: [],
			spawned: 1,
		});
		expect(stopped.at - idleAt).toBeGreaterThanOrEqual(graceMs);
		expect(fixture.opencodeDroppedEvents()).toEqual(
			["busy", "idle"].map((type) =>
				expect.objectContaining({
					payload: expect.objectContaining({
						type: "session.status",
						properties: expect.objectContaining({ status: { type } }),
					}),
				}),
			),
		);
	}, 120_000);

	it("re-adopts a busy survivor across a restart without a second spawn, and conduit stop ends it", async () => {
		const fixture = await start("restart-survival");
		const first = await fixture.connect();
		const sessionId = await first.createSession(
			"Survivor",
			instanceId,
			"opencode",
		);
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		await first.close();
		await fixture.terminate();
		const survivor = livePids(fixture);
		expect(survivor).toHaveLength(3);

		await fixture.restart();
		const browser = await fixture.connect();
		evidence["readopted"] = await keptRunning(fixture, browser);
		expect(livePids(fixture)).toEqual(survivor);

		const stop = await fixture.runCli(["stop"]);
		expect(stop.code).toBe(0);
		await fixture.waitForExit();
		await vi.waitFor(() => expect(livePids(fixture)).toEqual([]), {
			timeout: 15_000,
		});
		evidence["conduitStop"] = {
			code: stop.code,
			survivor,
			livePids: livePids(fixture),
		};
	}, 120_000);
});

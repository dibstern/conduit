import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: a crash mid-turn leaving the session stranded, needing a
// second user action, or never telling the browser; a crash while idle
// respawning OpenCode or warning about an outage nobody is waiting on.
describe("Managed OpenCode crash handling", () => {
	const instanceId = defaultInstanceIdForDriver("opencode");
	// Two health poll intervals (5s) plus the restart backoff's first delay (1s).
	const pastRestartMs = 2 * 5_000 + 1_000 + 1_000;
	let harness: ProcessHarness | undefined;
	let browser: Awaited<ReturnType<ProcessHarness["connect"]>> | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.9", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		// Long enough that no idle stop happens during a scenario.
		await harness.restart({ opencodeIdleTimeoutMs: 120_000 });
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

	/** Connection states the browser received for this instance since `cursor`. */
	const states = (
		viewer: Awaited<ReturnType<ProcessHarness["connect"]>>,
		cursor: number,
	) =>
		viewer.frames
			.slice(cursor)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["type"] === "project_setting" &&
					message["_tag"] === "opencodeConnection" &&
					message["instanceId"] === instanceId,
			)
			.map((message) => message["status"]);

	/** Kills the running fake OpenCode server by its exact PID. */
	function crash(fixture: ProcessHarness) {
		const server = spawned(fixture).at(-1);
		if (!server || !alive(server.pid)) throw new Error("No live fake OpenCode");
		process.kill(server.pid, "SIGKILL");
		return { killed: server.pid, at: Date.now(), before: livePids(fixture) };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["statusMessages"] = browser ? states(browser, 0) : [];
			await fixture.terminate();
			evidence["spawned"] = spawned(fixture);
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/pa3r-9-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
				browser = undefined;
			}
		}
	});

	it("restarts a crash mid-turn on its own and delivers the turn's later events", async () => {
		const fixture = await start("crash-busy");
		const viewer = await fixture.connect();
		browser = viewer;
		const sessionId = await viewer.createSession(
			"Busy",
			instanceId,
			"opencode",
		);
		await viewer.view(sessionId);
		await viewer.followSessions();
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		await viewer.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "busy",
		);

		const cursor = viewer.frames.length;
		evidence["crash"] = crash(fixture);
		await vi.waitFor(
			() =>
				expect(states(viewer, cursor)).toEqual(["reconnecting", "connected"]),
			{ timeout: 30_000, interval: 250 },
		);
		const restarted = {
			spawned: spawned(fixture).length,
			livePids: livePids(fixture).length,
			states: states(viewer, cursor),
		};
		evidence["restarted"] = restarted;
		expect(restarted).toEqual({
			spawned: 2,
			livePids: 3,
			states: ["reconnecting", "connected"],
		});

		// The restarted process reports idle through the typed shell feed.
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "idle",
		});
		const finished = await viewer.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "idle",
			cursor,
		);
		evidence["finished"] = finished;
	}, 120_000);

	it("leaves a crash with no demand stopped, without a restart or a warning", async () => {
		const fixture = await start("crash-idle");
		const viewer = await fixture.connect();
		browser = viewer;
		const sessionId = await viewer.createSession(
			"Idle",
			instanceId,
			"opencode",
		);
		await viewer.view(sessionId);

		const cursor = viewer.frames.length;
		evidence["crash"] = crash(fixture);
		await vi.waitFor(
			() => expect(states(viewer, cursor)).toContain("stopped"),
			{
				timeout: 30_000,
				interval: 250,
			},
		);
		await sleep(pastRestartMs);
		const quiet = {
			spawned: spawned(fixture).length,
			livePids: livePids(fixture),
			states: states(viewer, cursor),
		};
		evidence["afterCrash"] = quiet;
		expect(quiet).toEqual({ spawned: 1, livePids: [], states: ["stopped"] });
	}, 120_000);
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			turns: db
				.prepare("SELECT state FROM turns WHERE session_id = ?")
				.all(sessionId) as Array<{ state: string }>,
			terminalEvents: db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string }>,
			statusEvents: db
				.prepare(
					"SELECT data, metadata FROM events WHERE session_id = ? AND type = 'session.status' ORDER BY sequence",
				)
				.all(sessionId) as Array<{ data: string; metadata: string }>,
		};
	} finally {
		db.close();
	}
}

// Failure cases: restart marks a surviving turn idle, adoption emits a terminal
// event, a stale poller snapshot hides busy, or the adopted runner stops streaming.
describe("running Claude turn status across restart", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Array<Record<string, unknown>> = [];
	afterEach(async () => {
		await harness?.dispose();
		const remainingRunnerPids = harness?.remainingRunnerPids();
		expect(remainingRunnerPids).toEqual([]);
		const lastProof = proofs.at(-1);
		if (lastProof) lastProof["remainingRunnerPids"] = remainingRunnerPids;
		harness = undefined;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/conduit-test-ujwl-restart-status.json",
			JSON.stringify(proofs, null, 2),
		);
	});

	it.each([
		{ restart: "SIGINT", opencodeAvailable: false },
		{ restart: "RestartWithConfig", opencodeAvailable: false },
		{ restart: "SIGINT", opencodeAvailable: true },
		{ restart: "RestartWithConfig", opencodeAvailable: true },
	] as const)("reports an adopted running turn as processing after $restart with OpenCode available=$opencodeAvailable", async ({
		restart,
		opencodeAvailable,
	}) => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
			...(opencodeAvailable && { opencodeRecording: "chat-simple" }),
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Running across restart");
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				providerId: "claude",
				modelId: "claude-sonnet-4",
			}),
		);
		// This fixture pauses after its first delta until release-upgrade-turn.
		void browser.send(sessionId, "upgrade-long-turn").catch(() => undefined);
		await browser.waitFor(
			(message) =>
				message["type"] === "delta" && message["sessionId"] === sessionId,
		);
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("busy");
		});
		const before = persisted(harness, sessionId);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing runner PID");
		if (restart === "SIGINT") await harness.signal("SIGINT");
		else {
			await browser.restartServer();
			await harness.waitForExit();
		}
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		const stopped = persisted(harness, sessionId);
		await harness.restart();
		const reconnected = await harness.connect(sessionId);
		const initSnapshot = await reconnected.waitFor(
			(message) =>
				message["type"] === "status" && message["sessionId"] === sessionId,
		);
		const cursor = reconnected.frames.length;
		await reconnected.view(sessionId);
		const snapshot = await reconnected.waitFor(
			(message) =>
				message["type"] === "status" && message["sessionId"] === sessionId,
			cursor,
		);
		const adopted = harness.marks
			.filter((mark) => mark.kind === "runner-started")
			.at(-1);
		const resumed = persisted(harness, sessionId);
		const proof: Record<string, unknown> = {
			restart,
			opencodeAvailable,
			sessionId,
			runnerPid: runner.pid,
			adopted,
			before,
			stopped,
			resumed,
			initSnapshot,
			snapshot,
		};
		proofs.push(proof);
		expect(adopted).toMatchObject({ pid: runner.pid });
		expect(initSnapshot["status"]).toBe("processing");
		expect(snapshot["status"]).toBe("processing");
		expect(resumed.session.status).toBe("busy");
		expect(resumed.terminalEvents).toEqual(before.terminalEvents);
		expect(resumed.turns).toEqual([{ state: "running" }]);
		// The first poll is silent. When monitoring is enabled, its later busy
		// notification must carry the session ID required by frontend routing.
		if (opencodeAvailable) {
			const monitoringStatus = await reconnected.waitFor(
				(message) =>
					message["type"] === "status" && message["status"] === "processing",
				reconnected.frames.length,
			);
			proof["monitoringStatus"] = monitoringStatus;
			expect(monitoringStatus["sessionId"]).toBe(sessionId);
		}
		const streamingCursor = reconnected.frames.length;
		proof["restartResultCount"] = reconnected.frames.filter(
			({ message }) =>
				message["type"] === "result" && message["sessionId"] === sessionId,
		).length;
		expect(proof["restartResultCount"]).toBe(0);
		const done = reconnected.waitFor(
			(message) =>
				message["type"] === "done" && message["sessionId"] === sessionId,
		);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await done)["code"]).toBe(0);
		const continuedDeltaCount = reconnected.frames
			.slice(streamingCursor)
			.filter(
				({ message }) =>
					message["type"] === "delta" && message["sessionId"] === sessionId,
			).length;
		proof["continuedDeltaCount"] = continuedDeltaCount;
		expect(continuedDeltaCount).toBeGreaterThan(0);
		await vi.waitFor(() => {
			if (!harness) throw new Error("Missing harness");
			expect(persisted(harness, sessionId).session.status).toBe("idle");
		});
		proof["completed"] = persisted(harness, sessionId);
	}, 30_000);
});

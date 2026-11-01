// Failure modes: failed adoption strands restored account demand; retirement
// drops durable ownership; releasing one session cancels another; restart or
// later recovery reuses a released account generation or releases it twice.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

it.each([
	"update",
	"remove",
] as const)("%s completes after Cursor attachment retirement", async (change) => {
	const fixture = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		logLevel: "warn",
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const evidence: Record<string, unknown> = { change, passed: false };
	const capture = join(fixture.root, "capture.jsonl");
	const fault = join(fixture.root, "runner-attachment-drop.json");
	const trace = join(fixture.root, "cursor.jsonl");
	const serviceEnvironment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: trace,
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
	};
	const rows = (path: string): Record<string, unknown>[] =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	let db: Database.Database | undefined;
	try {
		writeFileSync(
			trace,
			readFileSync(
				resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
				"utf8",
			)
				.split("\n")
				.filter((line) => !line.startsWith('{"kind":"delta"'))
				.join("\n")
				.replaceAll('"status":"finished"', '"status":"cancelled"'),
		);
		await fixture.restart({ serviceEnvironment });
		const browser = await fixture.connect();
		const accounts: string[] = [];
		const sessions: string[] = [];
		for (const name of ["Retired", "Healthy"]) {
			const { addedInstanceId } = await fixture.requestRpc({
				_tag: "AddInstance",
				name,
				driver: "cursor",
				env: { CURSOR_API_KEY: `[REDACTED:${name}]` },
			});
			if (!addedInstanceId) throw new Error("No account allocated");
			accounts.push(addedInstanceId);
		}
		const accountId = accounts[0];
		const otherAccountId = accounts[1];
		if (!accountId || !otherAccountId) throw new Error("Missing accounts");
		for (const [name, owner] of [
			["Retired", accountId],
			["Healthy same account", accountId],
			["Healthy other account", otherAccountId],
		] as const) {
			const id = await browser.createSession(name, owner, "cursor", {
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "full",
			});
			sessions.push(id);
			void browser.send(id, "Say hello", 90_000).catch(() => {});
			await vi.waitFor(
				() =>
					expect(
						rows(capture).filter((row) => row["kind"] === "run.handle"),
					).toHaveLength(sessions.length),
				{ timeout: 30_000 },
			);
		}
		const sessionId = sessions[0];
		if (!sessionId) throw new Error("Missing retired owner");
		db = new Database(fixture.daemonStorePath());
		// The retirement row is pruned once the stopped process is gone, so
		// record it as its Stop escalates.
		db.exec(`CREATE TABLE runner_stops (runner_id TEXT, retired INTEGER, attachment_id TEXT, pid INTEGER);
			CREATE TRIGGER record_runner_stop AFTER UPDATE OF stop_state ON claude_runner_cursors
			WHEN NEW.stop_state = 'Escalating' AND OLD.stop_state <> 'Escalating'
			BEGIN INSERT INTO runner_stops VALUES (NEW.runner_id, NEW.retired_at IS NOT NULL, NEW.attachment_id, NEW.pid); END`);
		const runnerStops = db.prepare(
			"SELECT runner_id, retired, attachment_id, pid FROM runner_stops",
		);
		const retirement = db.prepare<[string]>(
			"SELECT retired_at, attachment_id, pid FROM claude_runner_cursors WHERE runner_id = ?",
		);
		const turn = db.prepare<[string], { state: string }>(
			"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
		);
		const states = () => sessions.map((id) => turn.get(id)?.state);
		await vi.waitFor(
			() => expect(states()).toEqual(["running", "running", "running"]),
			{ timeout: 30_000 },
		);
		const registrations = discoverRunners(
			fixture.projectDir,
			fixture.configDir,
		);
		const runner = registrations.find((entry) => entry.sessionId === sessionId);
		if (!runner) throw new Error("No registered runner");
		await fixture.terminate();
		writeFileSync(fault, JSON.stringify({ socketPaths: [runner.socketPath] }));
		await fixture.restart({ serviceEnvironment });
		const retired = [
			{
				runner_id: runner.runnerId,
				retired: 1,
				attachment_id: "",
				pid: runner.pid,
			},
		];
		await vi.waitFor(() => expect(runnerStops.all()).toEqual(retired), {
			timeout: 20_000,
		});
		expect(rows(`${fault}.ndjson`)).toHaveLength(1);
		expect(rows(`${fault}.attempts.ndjson`)).toHaveLength(5);
		evidence["retiredCursor"] = runnerStops.all();
		// A failed attachment's Stop kills the verified runner.
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{
				timeout: 10_000,
			},
		);
		evidence["restoredAttachmentDrops"] = rows(`${fault}.ndjson`);
		evidence["failedAttachments"] = rows(`${fault}.attempts.ndjson`);
		// A second restart must not revive the retired runner or restore its
		// account holds. Its row is pruned once the process is gone and its
		// runs are settled.
		await fixture.terminate();
		await fixture.restart({ serviceEnvironment });
		await vi.waitFor(
			() => expect(retirement.get(runner.runnerId)).toBeUndefined(),
			{ timeout: 20_000 },
		);
		expect(rows(`${fault}.attempts.ndjson`)).toHaveLength(5);
		expect(rows(`${fault}.ndjson`)).toHaveLength(1);
		expect(retirement.get(runner.runnerId)).toBeUndefined();
		// Prune deletes the retired runner's unread spool after Settle.
		expect(existsSync(`${runner.socketPath}.spool`)).toBe(false);
		expect(runnerStops.all()).toEqual(retired);
		evidence["restartWhileRetired"] = true;
		let settled = false;
		const changing = fixture
			.requestRpc(
				change === "update"
					? {
							_tag: "UpdateInstance",
							instanceId: accountId,
							env: { CURSOR_API_KEY: "[REDACTED:updated]" },
						}
					: { _tag: "RemoveInstance", instanceId: accountId },
			)
			.then(() => {
				settled = true;
			});
		void changing.catch(() => {});
		await vi.waitFor(
			() =>
				expect(
					settled,
					"account change must not wait on a retired socket",
				).toBe(true),
			{ timeout: 5000 },
		);
		await changing;
		await vi.waitFor(
			() => expect(states()).toEqual(["error", "interrupted", "running"]),
			{ timeout: 15_000 },
		);
		expect(
			rows(capture).filter((row) => row["kind"] === "cancel.call"),
		).toHaveLength(1);
		evidence["accountChangeCompleted"] = true;
		evidence["afterAccountChange"] = states();
		// Invalidation with no holds must also finish, including repeated updates.
		const { addedInstanceId: unusedAccountId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "No holds",
			driver: "cursor",
		});
		if (!unusedAccountId) throw new Error("Missing unused account");
		await fixture.requestRpc({
			_tag: "UpdateInstance",
			instanceId: unusedAccountId,
			env: { CURSOR_API_KEY: "[REDACTED:unused]" },
		});
		await fixture.requestRpc({
			_tag: "RemoveInstance",
			instanceId: unusedAccountId,
		});
		if (change === "update")
			await fixture.requestRpc({
				_tag: "UpdateInstance",
				instanceId: accountId,
				env: { CURSOR_API_KEY: "[REDACTED:updated-again]" },
			});
		evidence["invalidationWithoutHolds"] = true;
		await fixture.terminate();
		rmSync(fault);
		await fixture.restart({ serviceEnvironment });
		// Discovery finds only live runners; the retired one was killed.
		expect(
			discoverRunners(fixture.projectDir, fixture.configDir).find(
				(entry) => entry.sessionId === sessionId,
			),
		).toBeUndefined();
		if (change === "update") {
			expect(states()).toEqual(["error", "interrupted", "running"]);
			// Removing the updated account must not reattach the retired native turn.
			await fixture.requestRpc({
				_tag: "RemoveInstance",
				instanceId: accountId,
			});
		}
		await vi.waitFor(
			() => expect(states()).toEqual(["error", "interrupted", "running"]),
			{ timeout: 15_000 },
		);
		const terminals = db
			.prepare<[string], { type: string }>(
				"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted') ORDER BY sequence",
			)
			.all(sessionId);
		// Retirement settled the old runner's reached turn as process lost before
		// account changes (CONTRACT 3.8 reason 2.3, 82tn.32.2.16).
		expect(terminals).toContainEqual({
			type: "turn.error",
		});
		evidence["recoveredTerminal"] = terminals;
		await fixture.requestRpc({
			_tag: "RemoveInstance",
			instanceId: otherAccountId,
		});
		await vi.waitFor(
			() => expect(states()).toEqual(["error", "interrupted", "interrupted"]),
			{ timeout: 15_000 },
		);
		evidence["finalStates"] = states();
		await vi.waitFor(() =>
			expect(
				rows(capture).filter((row) => row["kind"] === "cancel.call"),
			).toHaveLength(2),
		);
		expect(
			rows(capture).filter((row) => row["kind"] === "run.handle"),
		).toHaveLength(3);
		evidence["nativeRuns"] = 3;
		evidence["nativeCancellations"] = 2;
		evidence["passed"] = true;
	} finally {
		db?.close();
		evidence["logTail"] = fixture.logTail;
		evidence["failedAttachments"] = rows(`${fault}.attempts.ndjson`);
		evidence["restoredAttachmentDrops"] = rows(`${fault}.ndjson`);
		rmSync(fault, { force: true });
		await fixture.dispose();
		evidence["remainingRunners"] = fixture.remainingRunnerPids();
		mkdirSync("test-results/82tn-32-16", { recursive: true });
		writeFileSync(
			`test-results/82tn-32-16/account-holds-${change}.json`,
			JSON.stringify(evidence, null, 2),
		);
		expect(fixture.remainingRunnerPids()).toEqual([]);
	}
}, 120_000);

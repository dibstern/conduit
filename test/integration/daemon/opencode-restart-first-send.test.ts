// After a daemon restart, the first send to an existing OpenCode session spawns a fresh process.
// That process must be linked to the session before the send's Run is written, so the Run ends
// by its own work (82tn.59; CONTRACT.md 9 "OpenCode adapter": process_started is reported when a
// session binds the instance or a daemon restart reattaches it). How it could fail:
// 1. the fresh process is linked only at the session's first event, after the send wrote its Run,
//    and that start retires the Run as lost;
// 2. the link is written twice for the same process (once at start, again at the first event);
// 3. the reply never reaches the browser, or the Run ends twice.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/account.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const read = (fixture: ProcessHarness, sessionId: string) => {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			started: db
				.prepare(
					"SELECT json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.reattached') AS reattached FROM events WHERE session_id = ? AND type = 'evidence.process_started' ORDER BY sequence",
				)
				.all(sessionId) as { runnerId: string; reattached: number }[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as { runId: string; reason: string }[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			// The order the store wrote the process's link and the Run's start in.
			timeline: (
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND (type LIKE 'evidence.process_%' OR type LIKE 'run.%') ORDER BY sequence",
					)
					.all(sessionId) as { type: string }[]
			).map(({ type }) => type),
		};
	} finally {
		db.close();
	}
};

it("after a daemon restart, the first send to an existing OpenCode session completes its Run and shows the reply", async () => {
	const fixture = (harness = ProcessHarness.create({
		managedOpenCode: true,
		managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
		autoStartOpenCode: true,
		managedOpenCodeStopGraceMs: 100,
	}));
	await fixture.restart();
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"First send after a restart",
		MANAGED_OPENCODE_ACCOUNT_ID,
		"opencode",
	);
	await browser.send(sessionId, "before the restart");
	const before = read(fixture, sessionId);
	expect(before.started).toHaveLength(1);
	expect(before.ends).toEqual([
		{ runId: before.runs[0]?.id, reason: "completed" },
	]);

	await fixture.terminate();
	const pids = join(fixture.configDir, "fake-opencode-pids.jsonl");
	const spawned = () =>
		existsSync(pids)
			? readFileSync(pids, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { pid: number })
			: [];
	const [old] = spawned();
	if (!old) throw new Error("No fake OpenCode");
	// The process dies while the daemon is down, so the next send spawns a fresh one.
	process.kill(old.pid, "SIGKILL");
	await fixture.restart();

	// The send comes first: nothing else touches the session or the instance before it.
	const next = await fixture.connect();
	const held = join(fixture.configDir, "fake-opencode-hold-turn");
	writeFileSync(held, "hold");
	const prompts = () =>
		fixture
			.opencodeRequestBodies()
			.filter(({ path }) => path === `/session/${sessionId}/prompt_async`);
	const sent = prompts().length;
	const turn = next.send(sessionId, "after the restart", 60_000);
	let userId: string | undefined;
	// test-waits-allow polling: the prompt body is recorded by the fake, another process.
	await vi.waitFor(
		() => {
			userId = (
				JSON.parse(prompts().at(sent)?.body ?? "{}") as { messageID?: string }
			).messageID;
			expect(userId).toBeTruthy();
		},
		{ timeout: 30_000 },
	);
	unlinkSync(held);
	const directory = realpathSync(fixture.projectDir);
	const emit = (type: string, properties: unknown) =>
		fixture.emitOpenCodeEvent({
			directory,
			payload: { id: `evt_${randomUUID()}`, type, properties },
		});
	const created = Date.now();
	const assistantId = `msg_${randomUUID()}`;
	await emit("message.updated", {
		info: {
			id: userId,
			sessionID: sessionId,
			role: "user",
			time: { created },
		},
	});
	const assistant = (completed: boolean) =>
		emit("message.updated", {
			info: {
				id: assistantId,
				sessionID: sessionId,
				role: "assistant",
				parentID: userId,
				time: { created, ...(completed && { completed: Date.now() }) },
				...(completed && { finish: "stop" }),
			},
		});
	await assistant(false);
	await emit("message.part.updated", {
		part: {
			id: `prt_${randomUUID()}`,
			sessionID: sessionId,
			messageID: assistantId,
			type: "text",
			text: "Reply after the restart.",
		},
	});
	await assistant(true);
	await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
		type: "idle",
	});
	const { chunks } = await turn;

	// test-waits-allow polling: the ledger's writes land in the daemon's store, another process.
	await vi.waitFor(
		() =>
			expect(read(fixture, sessionId).runs.at(-1)?.status).toBe("completed"),
		{ timeout: 15_000, interval: 100 },
	);
	const after = read(fixture, sessionId);
	const nextRun = after.runs.at(-1)?.id;
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn-59-restart-first-send.json",
		JSON.stringify(
			{
				ticket: "conduit-test-82tn.59",
				spawned: spawned().length,
				before,
				after,
				reply: chunks,
			},
			null,
			2,
		),
	);
	expect(spawned()).toHaveLength(2);
	expect(chunks.join("")).toBe("Reply after the restart.");
	const [first, second] = after.started;
	expect(after.started).toHaveLength(2);
	expect(second?.runnerId).not.toBe(first?.runnerId);
	expect(second?.reattached).toBe(0);
	expect(after.ends).toEqual([
		{ runId: before.runs[0]?.id, reason: "completed" },
		{ runId: nextRun, reason: "completed" },
	]);
});

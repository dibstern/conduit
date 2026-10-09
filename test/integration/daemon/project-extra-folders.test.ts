import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveProject } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { ClaudeTraceName } from "../../e2e/helpers/claude-trace-replayer.js";
import { readNativeThread } from "../../helpers/native-thread.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const MARKER = "CONDUIT-EXTRA-FOLDER-MARKER-7f3a";
const EXTRA_FOLDER_TRACE = join(
	import.meta.dirname,
	"../../fixtures/claude-sdk-traces/extra-folder-read-turn.jsonl",
);

function runnerOptions(harness: ProcessHarness, sessionId: string) {
	const pids = new Set(
		harness.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	return harness
		.claudeOptions()
		.filter(({ pid, options }) => pids.has(pid) && options["maxTurns"] !== 0);
}

describe("Claude project extra folders through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(
		name: string,
		turns: readonly ClaudeTraceName[],
		delayMs?: number,
	) {
		scenario = name;
		evidence = {
			ticket: "conduit-test-usg5.6",
			at: new Date().toISOString(),
			turns,
		};
		harness = ProcessHarness.create({
			claudeReplay: { turns, ...(delayMs === undefined ? {} : { delayMs }) },
		});
		evidence["main"] = harness.projectDir;
		await harness.restart();
		return harness;
	}

	async function save(fixture: ProcessHarness, folders: readonly string[]) {
		const input = { slug: "process-test", folders };
		const saved = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new SaveProject(input),
		);
		evidence["save"] = { input, result: saved };
		expect(saved.savedSlug).toBe("process-test");
		expect(saved.warnings).toEqual([]);
		expect(
			saved.projects.find(({ slug }) => slug === saved.savedSlug)?.folders,
		).toEqual(folders);
		return saved;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["failures"] =
				task.result?.errors?.map(({ message, stack }) => ({
					message,
					stack,
				})) ?? [];
			evidence["recordedOptions"] = fixture.claudeOptions();
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/usg5-6-${scenario}.json`,
					JSON.stringify(
						{
							...evidence,
							process: fixture.proof(),
							runnerPids: fixture.runnerPids(),
							remainingRunnerPids: fixture.remainingRunnerPids(),
						},
						null,
						2,
					),
				);
				harness = undefined;
			}
		}
	});

	it("reads an extra-folder marker using the captured Claude turn", async (context) => {
		if (!existsSync(EXTRA_FOLDER_TRACE)) {
			mkdirSync("test-results", { recursive: true });
			const reason =
				"Real Claude trace extra-folder-read-turn.jsonl is absent. Run the opt-in claude-extra-folder-trace-capture.test.ts capture before replaying this scenario.";
			writeFileSync(
				"test-results/usg5-6-extra-folder.json",
				JSON.stringify(
					{ ticket: "conduit-test-usg5.6", skipped: reason },
					null,
					2,
				),
			);
			context.skip(reason);
			return;
		}
		const fixture = await start("extra-folder", ["extra-folder-read-turn"]);
		const extra = join(fixture.root, "extra-folder");
		mkdirSync(extra);
		const markerPath = join(extra, "marker.txt");
		writeFileSync(markerPath, MARKER);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Extra folder marker");
		evidence["sessionId"] = sessionId;
		const reply = await browser.send(
			sessionId,
			`Use the Read tool to read the file at the absolute path ${markerPath}, then reply with its contents.`,
		);
		evidence["reply"] = reply;
		expect(reply.done["status"]).toBe("idle");
		expect(reply.chunks.join("")).toContain(MARKER);
		await vi.waitFor(async () => {
			const history = await browser.history(sessionId);
			evidence["history"] = history;
			const text = history
				.filter(({ role }) => role === "assistant")
				.flatMap(({ parts }) => parts ?? [])
				.map(({ text }) => text ?? "")
				.join("");
			expect(text).toContain(MARKER);
		});
		expect(runnerOptions(fixture, sessionId).at(-1)?.options).toMatchObject({
			cwd: fixture.projectDir,
			additionalDirectories: [extra],
		});
	}, 60_000);

	it("uses current folders on the next turn of an existing live runner", async () => {
		const fixture = await start("live-runner", [
			"pong-thinking-text-turn",
			"pong-thinking-text-turn",
		]);
		await save(fixture, [fixture.projectDir]);
		const before = await fixture.connect();
		const sessionId = await before.createSession("Live runner folder change");
		evidence["sessionId"] = sessionId;
		const first = await before.send(sessionId, "Reply with pong.");
		expect(first.done["status"]).toBe("idle");
		expect(first.chunks.join("")).toBe("pong");
		const original = runnerOptions(fixture, sessionId).at(-1);
		if (!original) throw new Error("Missing live runner query options");
		expect(original.options["cwd"]).toBe(fixture.projectDir);
		expect(original.options).not.toHaveProperty("additionalDirectories");
		expect(() => process.kill(original.pid, 0)).not.toThrow();
		evidence["originalQuery"] = original;
		const extra = join(fixture.root, "added-extra-folder");
		mkdirSync(extra);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const after = await fixture.connect(sessionId);
		// Let relay adoption acknowledge the prior turn's remaining outputs.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const second = await after.send(sessionId, "Reply with pong again.");
		evidence["replies"] = [first, second];
		expect(second.done["status"]).toBe("idle");
		expect(second.chunks.join("")).toBe("pong");
		const options = runnerOptions(fixture, sessionId);
		evidence["sessionQueries"] = options;
		expect(options.length).toBeGreaterThan(1);
		expect(options.at(-1)?.options).toMatchObject({
			cwd: fixture.projectDir,
			additionalDirectories: [extra],
		});
		const history = await after.history(sessionId);
		evidence["history"] = history;
		expect(history.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	}, 60_000);

	it("restarts an idle live runner on the next send after its folders change", async () => {
		const fixture = await start("running-folder-change", [
			"pong-thinking-text-turn",
			"pong-thinking-text-turn",
		]);
		await save(fixture, [fixture.projectDir]);
		const before = await fixture.connect();
		const sessionId = await before.createSession("Running turn folder change");
		evidence["sessionId"] = sessionId;
		const first = await before.send(sessionId, "Reply with pong.");
		expect(first.done["status"]).toBe("idle");
		expect(first.chunks.join("")).toBe("pong");
		const original = runnerOptions(fixture, sessionId).at(-1);
		if (!original) throw new Error("Missing live runner query options");
		expect(original.options).not.toHaveProperty("additionalDirectories");
		expect(() => process.kill(original.pid, 0)).not.toThrow();
		evidence["originalQuery"] = original;
		const extra = join(fixture.root, "added-during-turn");
		mkdirSync(extra);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const after = await fixture.connect(sessionId);
		let resumeSessionId: string | undefined;
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			// Completion can arrive while SaveProject replaces the relay, before
			// this browser reconnects. The durable turn survives that WS gap.
			await vi.waitFor(
				async () => {
					const turns = db
						.prepare(
							"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
						)
						.all(sessionId);
					const errors = db
						.prepare(
							"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.error', 'turn.interrupted') ORDER BY sequence",
						)
						.all(sessionId);
					resumeSessionId = (
						await readNativeThread(fixture.projectStorePath(), sessionId)
					)?.resumeSessionId;
					evidence["turnsBeforeNextSend"] = turns;
					evidence["turnErrorsBeforeNextSend"] = errors;
					evidence["resumeSessionIdBeforeNextSend"] = resumeSessionId;
					expect(turns).toEqual([{ state: "completed" }]);
					expect(errors).toEqual([]);
					expect(typeof resumeSessionId).toBe("string");
					expect(resumeSessionId).not.toBe("");
				},
				{ timeout: 10_000, interval: 50 },
			);
		} finally {
			db.close();
		}
		expect(() => process.kill(original.pid, 0)).not.toThrow();
		evidence["liveBeforeNextSend"] = true;
		// Let relay adoption acknowledge the prior turn's remaining outputs.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const firstHistory = await after.history(sessionId);
		evidence["historyBeforeNextSend"] = firstHistory;
		expect(firstHistory.map(({ role }) => role)).toEqual(["user", "assistant"]);
		expect(
			firstHistory[1]?.parts
				?.filter(({ type }) => type === "text")
				.map(({ text }) => text ?? "")
				.join(""),
		).toBe("pong");
		const second = await after.send(sessionId, "Reply with pong again.");
		evidence["secondReply"] = second;
		expect(second.done["status"]).toBe("idle");
		expect(second.chunks.join("")).toBe("pong");
		evidence["idleRunnerEndedAtSend"] = fixture.marks.some(
			(mark) =>
				mark.kind === "runner-end-selected" && mark.sessionId === sessionId,
		);
		expect(evidence["idleRunnerEndedAtSend"]).toBe(true);
		const current = runnerOptions(fixture, sessionId).at(-1);
		evidence["replacementQuery"] = current;
		expect(current?.pid).not.toBe(original.pid);
		expect(current?.options).toMatchObject({
			cwd: fixture.projectDir,
			additionalDirectories: [extra],
			resume: resumeSessionId,
		});
		const history = await after.history(sessionId);
		evidence["history"] = history;
		expect(history.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	}, 60_000);

	it("drops a deleted extra folder from the launch", async () => {
		const fixture = await start("missing-extra", ["pong-thinking-text-turn"]);
		const extra = join(fixture.root, "deleted-extra-folder");
		mkdirSync(extra);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Missing extra folder");
		evidence["sessionId"] = sessionId;
		await browser.preWarmSession(sessionId);
		expect(runnerOptions(fixture, sessionId).at(-1)?.options).toMatchObject({
			additionalDirectories: [extra],
		});
		rmSync(extra, { recursive: true });
		const reply = await browser.send(sessionId, "Reply with pong.");
		evidence["reply"] = reply;
		expect(reply.done["status"]).toBe("idle");
		expect(reply.chunks.join("")).toBe("pong");
		const current = runnerOptions(fixture, sessionId).at(-1)?.options;
		expect(current?.["cwd"]).toBe(fixture.projectDir);
		expect(current).not.toHaveProperty("additionalDirectories");
	}, 60_000);

	it("fails a turn when its saved main folder has disappeared", async () => {
		const fixture = await start("missing-main", ["pong-thinking-text-turn"]);
		await save(fixture, [fixture.projectDir]);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Missing main folder");
		evidence["sessionId"] = sessionId;
		await browser.preWarmSession(sessionId);
		rmSync(fixture.projectDir, { recursive: true });
		const reply = await browser.send(sessionId, "Reply with pong.");
		evidence["reply"] = reply;
		expect(reply.done["lastTurnEndVersion"]).toEqual(expect.any(Number));
		expect(reply.chunks).toEqual([]);
		// An identical failure is still its own turn error, not swallowed.
		const repeat = await browser.send(sessionId, "Reply with pong.");
		evidence["repeat"] = repeat;
		expect(repeat.done["lastTurnEndVersion"]).toEqual(expect.any(Number));
		// The failure is a turn error in the transcript, so it survives a reload.
		const history = await browser.history(sessionId);
		evidence["history"] = history;
		const notices = history
			.flatMap(({ parts }) => parts ?? [])
			.filter(({ type }) => type === "error");
		expect(notices).toHaveLength(2);
		for (const notice of notices) {
			expect(String(notice.text)).toContain(fixture.projectDir);
		}
	}, 60_000);
});

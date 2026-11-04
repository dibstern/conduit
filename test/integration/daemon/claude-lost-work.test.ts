// Lost work (82tn.32.25; CONTRACT.md 8.4 L5 2907-2916), over the isolated process harness and the
// fake Claude SDK's held task-stop turn. How it could fail (lane 3225 audit):
// 12. a process lost with tasks live or unknown records nothing;
// 13. a process lost with no tasks still records a lost-work entry;
// 14. the entry is a transient toast, not a timeline entry, or is gone after a reload.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskStopFixture } from "../../helpers/fake-claude-process-sdk.js";
import {
	type ProcessBrowser as BrowserClient,
	ProcessHarness,
} from "../../helpers/process-harness.js";

type Row = Record<string, unknown>;
type Shown = {
	readonly kind?: string;
	readonly type: string;
	readonly description: string;
	readonly detail?: string;
};

/** The decided copy for a task: "pnpm test (shell)", else "(kind): description". */
const named = ({ kind, type, description, detail }: Shown) =>
	detail ? `${detail} (${kind ?? type})` : `(${kind ?? type}): ${description}`;

/** The session timeline's notice texts, as a reload reads them. */
const notices = async (browser: BrowserClient, sessionId: string) =>
	(await browser.history(sessionId)).flatMap((message) =>
		(message.parts ?? []).flatMap((part) =>
			part.type === "notice" && part.text ? [part.text] : [],
		),
	);

const lostNotices = async (browser: BrowserClient, sessionId: string) =>
	(await notices(browser, sessionId)).filter((text) =>
		text.startsWith("Background work"),
	);

/** Kills the session's runner outright, as an unplanned loss. */
const killRunner = async (harness: ProcessHarness) => {
	const [pid] = harness.remainingRunnerPids();
	expect(pid).toBeDefined();
	expect(harness.signalOwnedRunner(pid ?? 0, "SIGKILL")).toBe(true);
	// test-waits-allow polling: the runner's exit shows only in the process table.
	await vi.waitFor(() => expect(harness.remainingRunnerPids()).toEqual([]));
};

describe("lost background work", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
		} finally {
			proof[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-25-lost-work.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("names a killed process's live tasks in the timeline, after a reload too", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Lost work");
		await browser.followSession(sessionId);
		void browser.send(sessionId, "task-stop-foreground").catch(() => undefined);
		const live = (await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				Array.isArray(message["backgroundTasks"]) &&
				message["backgroundTasks"].length === taskStopFixture.length,
		)) as Row;
		const tasks = live["backgroundTasks"] as Shown[];
		await killRunner(harness);
		// test-waits-allow polling: the notice is read back as history, which has no push to wait on.
		const lost = await vi.waitFor(async () => {
			const found = await lostNotices(browser, sessionId);
			expect(found).toHaveLength(1);
			return found;
		});
		proof["killed with tasks: notice"] = lost;
		for (const task of tasks) expect(lost[0]).toContain(named(task));
		const reloaded = await harness.connect(sessionId);
		const afterReload = await lostNotices(reloaded, sessionId);
		proof["killed with tasks: after reload"] = afterReload;
		expect(afterReload).toEqual(lost);
	});

	it("records nothing when a process with no tasks is lost", async () => {
		harness = await ProcessHarness.start({ restartProof: true });
		const browser = await harness.connect();
		const sessionId = await browser.createSession("No lost work");
		await browser.followSession(sessionId);
		await browser.send(sessionId, "hello");
		await killRunner(harness);
		const turned = await browser.send(sessionId, "hello again");
		proof["killed with no tasks: next turn"] = turned.chunks;
		const lost = await lostNotices(browser, sessionId);
		proof["killed with no tasks: notices"] = lost;
		expect(lost).toEqual([]);
	});
});

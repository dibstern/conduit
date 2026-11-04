// What a session is doing reads the same on every feed at every step (82tn.32.30; CONTRACT.md 8.1
// "SessionActivity is a read-only view"), over the isolated process harness and the recorded
// background-shell-turn trace: the user turn (shell task started, trace line 56), the gap after its
// result (line 84) while the shell still runs, and Claude's wake turn (held before its result at
// line 153). How it could fail (lane audit):
// 1. a wake Run reads idle or done on the sidebar (4ejl7);
// 3. tasks running after the turn make the foreground read working, or read idle;
// 12. the shell feed (sidebar) and the family feed (chat) send different answers for one step;
// 15. a stored sidebar row keeps reading working after the session goes idle;
// 18. a fresh connection (a reload) reads a different answer than the live page.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const PROOF = "test-results/82tn-32-30-session-activity.json";

/** The latest session_row each feed sent for the session. */
const latest = (browser: ProcessBrowser, sessionId: string) => {
	let feed = "";
	const last: Record<string, Record<string, unknown>> = {};
	for (const { message } of browser.frames) {
		if (message["type"] === "shell" || message["type"] === "family")
			feed = String(message["type"]);
		if (message["type"] === "session_row" && message["id"] === sessionId)
			last[feed] = message;
	}
	return last;
};

const shown = (row: Record<string, unknown> | undefined) => ({
	activity: row?.["activity"] ?? null,
	attention: row?.["attention"] ?? null,
	processing: row?.["processing"] ?? false,
	wakeRun: row?.["wakeRun"] ?? null,
});

describe("Session activity over a Claude background shell and its wake", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[task.name] = {
				...(proof[task.name] as object),
				outcome: task.result?.state === "pass" ? "passed" : "failed",
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
			harness = undefined;
		}
	});

	it("reads one answer on the sidebar and chat feeds at every step, and after a reload", async () => {
		const name =
			"reads one answer on the sidebar and chat feeds at every step, and after a reload";
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["background-shell-turn"] },
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Session activity");
		await browser.followFamily(sessionId);
		const hold = join(fixture.root, "claude-replay-hold");
		const reached = () =>
			existsSync(`${hold}.reached`)
				? readFileSync(`${hold}.reached`, "utf8").split("\n").filter(Boolean)
						.length
				: 0;
		const steps: Record<string, unknown>[] = [];
		proof[name] = { sessionId, steps };
		/** Holds the replay before `message`, then waits until both feeds read `expected`. */
		const step = async (
			label: string,
			message: number,
			expected: ReturnType<typeof shown>,
			start?: () => void,
		) => {
			const id = steps.length + 1;
			writeFileSync(hold, JSON.stringify({ turn: 1, message, id }));
			start?.();
			// test-waits-allow polling: the held replay line reports only through this file.
			await vi.waitFor(() => expect(reached()).toBe(id), { timeout: 10_000 });
			const record: Record<string, unknown> = { label, message, expected };
			steps.push(record);
			// Every step is recorded before any is judged, so a red run shows them all.
			// test-waits-allow polling: rows are coalesced up to a second after the change.
			await vi
				.waitFor(
					() => {
						const rows = latest(browser, sessionId);
						record["shell"] = shown(rows["shell"]);
						record["family"] = shown(rows["family"]);
						expect(record["shell"]).toEqual(expected);
						expect(record["family"]).toEqual(expected);
					},
					{ timeout: 5_000 },
				)
				.catch(() => {});
			// A reload: a fresh connection's first rows on both feeds.
			const reload = await fixture.connect();
			await reload.followSessions();
			await reload.followFamily(sessionId);
			const rows = latest(reload, sessionId);
			record["reload"] = {
				shell: shown(rows["shell"]),
				family: shown(rows["family"]),
			};
			await reload.close();
		};

		await step(
			"the user turn, its shell started",
			84,
			{
				activity: {
					foreground: "working",
					background: "work",
					label: "working",
				},
				attention: "working",
				processing: true,
				wakeRun: null,
			},
			() => {
				browser
					.send(sessionId, "Run sleep 8 in the background")
					.catch(() => {});
			},
		);
		await step("after the turn's result, the shell still running", 85, {
			activity: { foreground: "idle", background: "work", label: "working" },
			attention: "working",
			processing: true,
			wakeRun: null,
		});
		await step("Claude's wake turn (4ejl7)", 153, {
			activity: { foreground: "working", background: "none", label: "working" },
			attention: "working",
			processing: true,
			wakeRun: { task: "sleep 8" },
		});
		rmSync(hold);
		const done: Record<string, unknown> = { label: "after the wake" };
		steps.push(done);
		const idle = {
			foreground: "idle",
			background: "none",
			label: "idle",
		};
		// test-waits-allow polling: rows are coalesced up to a second after the change.
		await vi
			.waitFor(
				() => {
					const rows = latest(browser, sessionId);
					done["shell"] = shown(rows["shell"]);
					done["family"] = shown(rows["family"]);
					expect(done["shell"]).toMatchObject({ activity: idle });
					expect(done["family"]).toMatchObject({ activity: idle });
				},
				{ timeout: 10_000 },
			)
			.catch(() => {});
		for (const { label, expected, shell, family, reload } of steps.slice(0, -1))
			expect({ shell, family, reload }, String(label)).toEqual({
				shell: expected,
				family: expected,
				reload: { shell: expected, family: expected },
			});
		expect(done["shell"]).toMatchObject({
			activity: idle,
			processing: false,
			wakeRun: null,
		});
		expect(done["family"]).toEqual(done["shell"]);
	});
});

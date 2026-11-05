// A session starting and finishing work reaches an open tab's sidebar live (82tn.63). Since
// 82tn.32.30 the stored sidebar row holds no busy; Session Activity supplies it at read (CONTRACT.md
// 8.1, 2734), so only an announce that moves the stored row wakes the shell feed. Over the process
// harness and the recorded subagent-task-turn trace, one tab shows project A and never opens
// project B. In each project a root's turn runs a subagent child; held at each step, the tab's
// sidebar row and the session view must agree. How it could fail (lane audit):
// 1-3. a root's Run start or end is not re-sent, in the tab's project or another;
// 4. a child's Run start or end leaves its root's roll-up stale (the root's own Run spans the
//    child's, so the roll-up reads working throughout; asserted with the child's Run state);
// 5. the change arrives only through a new snapshot, not a live upsert;
// 6. a row is re-sent at a row version the tab already holds;
// 7. the session view reads a different answer from the sidebar.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

type Row = Record<string, unknown>;
type Activity = { foreground?: string; label?: string } | undefined;

/** What the tab's sidebar shows for a root: its roll-up (attention, processing) and own view. */
const sidebar = (row: Row | undefined) => ({
	attention: row?.["attention"] ?? null,
	processing: row?.["processing"] ?? false,
	label: (row?.["activity"] as Activity)?.label ?? null,
});

/** The session view: the family feed's own answer for one session. */
const inSession = (row: Row | undefined) =>
	(row?.["activity"] as Activity)?.foreground ?? null;

/** Every shell frame the tab received that carries `id`, in order. */
const shellFrames = (browser: ProcessBrowser, id: string) =>
	browser.frames.flatMap(({ message }) => {
		if (message["type"] !== "shell") return [];
		const tag = message["_tag"];
		const rows =
			tag === "snapshot"
				? (message["rows"] as Row[])
				: tag === "upsert"
					? [message["item"] as Row]
					: [];
		return rows
			.filter((row) => row["id"] === id)
			.map((row) => ({
				tag,
				sequence: message["sequence"],
				...sidebar(row),
			}));
	});

const latestShell = (browser: ProcessBrowser, id: string) =>
	shellFrames(browser, id).at(-1);

/** The latest row the session view's family feed sent for `id`. */
const latestFamily = (browser: ProcessBrowser, id: string) => {
	let feed = "";
	let last: Row | undefined;
	for (const { message } of browser.frames) {
		if (message["type"] === "shell" || message["type"] === "family")
			feed = String(message["type"]);
		if (
			feed === "family" &&
			message["type"] === "session_row" &&
			message["id"] === id
		)
			last = message;
	}
	return last;
};

const childOf = (browser: ProcessBrowser, rootId: string) => {
	for (const { message } of browser.frames)
		if (message["type"] === "session_row" && message["parentID"] === rootId)
			return String(message["id"]);
	return undefined;
};

/** The child's Runs as the Run Ledger holds them. */
const runsOf = (fixture: ProcessHarness, sessionId: string) => {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY requested_at",
			)
			.all(sessionId);
	} finally {
		db.close();
	}
};

const WORKING = { attention: "working", processing: true, label: "working" };

describe("a session's working state reaches an open tab's sidebar (82tn.63)", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness?.assertNoRunners();
		harness = undefined;
	});

	it("re-sends the root's row live as its turn and its child start and end, in the tab's project and another", async () => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["subagent-task-turn"] },
		});
		harness = fixture;
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const { savedSlug: slugB } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		// The tab shows project A and only follows the sidebar: it never opens a session.
		const tab = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const hold = join(fixture.root, "claude-replay-hold");
		const reached = () =>
			existsSync(`${hold}.reached`)
				? readFileSync(`${hold}.reached`, "utf8").split("\n").filter(Boolean)
						.length
				: 0;
		let holds = 0;
		const failures: string[] = [];

		for (const [project, slug] of [
			["shown", "process-test"],
			["not-shown", slugB],
		] as const) {
			const caseName = `root-and-child-${project}`;
			const steps: Record<string, unknown>[] = [];
			const proof: Record<string, unknown> = {
				bead: "conduit-test-82tn.63",
				case: caseName,
				tabProject: "process-test",
				sessionProject: slug,
				steps,
			};
			// The session view: another browser that opens the session in its own project.
			const viewer = await fixture.connect(undefined, undefined, slug, false);
			const root = await viewer.createSession(`Sidebar ${project}`);
			proof["rootId"] = root;
			/** Waits until the tab and the session view read `expected`; records every step. */
			const check = async (
				label: string,
				expected: {
					readonly root: ReturnType<typeof sidebar>;
					readonly rootInSession: string;
					readonly childRuns?: readonly { status: string }[];
				},
			) => {
				const record: Record<string, unknown> = { label, expected };
				steps.push(record);
				// test-waits-allow polling: rows are coalesced up to a second after the change.
				await vi
					.waitFor(
						() => {
							const child = childOf(viewer, root);
							const row = latestShell(tab, root);
							record["tab"] = row ?? null;
							record["rootInSession"] = inSession(latestFamily(viewer, root));
							record["childId"] = child ?? null;
							// Recorded, not asserted: a Claude subagent child's Run is not a Run Ledger
							// Run (8.1, 2727), so its own view reads idle while it runs (lane 63 report).
							record["childInSession"] = child
								? inSession(latestFamily(viewer, child))
								: null;
							record["tabChild"] = child
								? (latestShell(tab, child) ?? null)
								: null;
							record["childRuns"] = child ? runsOf(fixture, child) : [];
							expect({
								attention: row?.attention,
								processing: row?.processing,
								label: row?.label,
							}).toEqual(expected.root);
							expect(record["rootInSession"]).toBe(expected.rootInSession);
							expect(record["childRuns"]).toEqual(expected.childRuns ?? []);
						},
						{ timeout: 10_000 },
					)
					.catch((error: unknown) => {
						record["failure"] = String(error);
						failures.push(`${caseName} / ${label}: ${String(error)}`);
					});
			};
			/** Holds the replay before trace line `message`, then checks the step. */
			const step = async (
				label: string,
				message: number,
				expected: Parameters<typeof check>[1],
				start?: () => void,
			) => {
				const id = ++holds;
				writeFileSync(hold, JSON.stringify({ turn: 1, message, id }));
				start?.();
				// test-waits-allow polling: the held replay line reports only through this file.
				await vi.waitFor(() => expect(reached()).toBe(id), { timeout: 30_000 });
				await check(label, expected);
			};

			let turn: Promise<unknown> | undefined;
			await step(
				"the root's turn started, no child yet",
				10,
				{ root: WORKING, rootInSession: "working" },
				() => {
					turn = viewer
						.send(root, "Ask a subagent to summarise package.json")
						.catch((error: unknown) => error);
				},
			);
			await step("the child runs (after its first tool call)", 36, {
				root: WORKING,
				rootInSession: "working",
				childRuns: [{ status: "running" }],
			});
			await step("the child ended, the root still runs", 40, {
				root: WORKING,
				rootInSession: "working",
				childRuns: [{ status: "completed" }],
			});
			rmSync(hold);
			await turn;
			await check("the root's turn ended", {
				// The viewer has the session open, so the tab may read it seen or unseen; never working.
				root: {
					attention: expect.stringMatching(/^(idle|done-unread)$/),
					processing: false,
					label: "idle",
				},
				rootInSession: "idle",
				childRuns: [{ status: "completed" }],
			});

			// 5. One snapshot: every change reached the open tab as a live upsert, never a reload.
			const frames = shellFrames(tab, root);
			proof["tabFrames"] = frames;
			proof["tabSnapshots"] = tab.frames.filter(
				({ message }) =>
					message["type"] === "shell" && message["_tag"] === "snapshot",
			).length;
			// 6. Each re-send carries a fresh row version.
			const sequences = frames
				.filter(({ tag }) => tag === "upsert")
				.map(({ sequence }) => Number(sequence));
			proof["freshVersions"] = sequences.every(
				(sequence, index) =>
					index === 0 || sequence > (sequences[index - 1] ?? 0),
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-63-${caseName}.json`,
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			expect(proof["tabSnapshots"]).toBe(1);
			expect(proof["freshVersions"]).toBe(true);
			expect(
				frames.filter(({ tag }) => tag === "upsert").length,
			).toBeGreaterThan(0);
			await viewer.close();
		}
		expect(failures).toEqual([]);
	});
});

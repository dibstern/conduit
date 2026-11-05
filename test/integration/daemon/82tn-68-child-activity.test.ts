// A Claude subagent child's own session view reads working while its Run runs and idle after
// (82tn.68). The Claude runtime opens the child's Run itself, so the Run Ledger never holds it
// (CONTRACT.md 8.1, 2727 names no rule for it); Session Activity reads the child's own run record.
// Over the process harness and the recorded subagent-task-turn trace, held at each step. How it
// could fail (lane audit):
// 1. the child's view reads idle while its run record reads running;
// 2. the child's view keeps reading working after its run record ends;
// 3. the change reaches the child's view only through a new snapshot, not a live upsert;
// 4. the root's sidebar row changes from today, or the tab is sent a second snapshot;
// 5. the shell feed starts carrying child rows;
// 6. the session list reads the child differently from its session view;
// 8. the root's own session-view answer changes.

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

const PROOF = "test-results/82tn-68-child-activity.json";

/** What a session view shows for a session: its own answer. */
const shown = (row: Row | undefined) => ({
	foreground: (row?.["activity"] as Activity)?.foreground ?? null,
	label: (row?.["activity"] as Activity)?.label ?? null,
});

/** What the tab's sidebar shows for a root: its roll-up and own label. */
const sidebar = (row: Row | undefined) => ({
	attention: row?.["attention"] ?? null,
	processing: row?.["processing"] ?? false,
	label: (row?.["activity"] as Activity)?.label ?? null,
});

/** Every family-feed frame a browser received for `id`, in order, with the feed's tag. */
const familyFrames = (browser: ProcessBrowser, id: string) => {
	const frames: Record<string, unknown>[] = [];
	let tag: unknown;
	for (const { message } of browser.frames) {
		if (message["type"] === "family") tag = message["_tag"];
		if (message["type"] === "shell") tag = undefined;
		if (
			tag !== undefined &&
			message["type"] === "session_row" &&
			message["id"] === id
		)
			frames.push({ tag, ...shown(message) });
	}
	return frames;
};

/** Every shell (sidebar) frame the tab received for `id`. */
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
			.map((row) => ({ tag, sequence: message["sequence"], ...sidebar(row) }));
	});

const childOf = (browser: ProcessBrowser, rootId: string) => {
	for (const { message } of browser.frames)
		if (message["type"] === "session_row" && message["parentID"] === rootId)
			return String(message["id"]);
	return undefined;
};

const runsOf = (fixture: ProcessHarness, sessionId: string) => {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY requested_at",
			)
			.all(sessionId) as { status: string }[];
	} finally {
		db.close();
	}
};

const WORKING = { foreground: "working", label: "working" };
const IDLE = { foreground: "idle", label: "idle" };
const ROOT_WORKING = {
	attention: "working",
	processing: true,
	label: "working",
};

describe("a Claude subagent child's session view reads its own Run (82tn.68)", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness?.assertNoRunners();
		harness = undefined;
	});

	it("reads working while the child runs and idle after, live, with the root's sidebar unchanged", async () => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["subagent-task-turn"] },
		});
		harness = fixture;
		// The tab only follows the sidebar; the viewer opens the root; the child view opens the child.
		const tab = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const viewer = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const root = await viewer.createSession("Child activity");
		let childView: ProcessBrowser | undefined;
		const hold = join(fixture.root, "claude-replay-hold");
		const reached = () =>
			existsSync(`${hold}.reached`)
				? readFileSync(`${hold}.reached`, "utf8").split("\n").filter(Boolean)
						.length
				: 0;
		let holds = 0;
		const steps: Record<string, unknown>[] = [];
		const failures: string[] = [];
		const proof: Record<string, unknown> = {
			bead: "conduit-test-82tn.68",
			rootId: root,
			steps,
		};

		const listed = async (id: string) => {
			const { sessions } = await fixture.requestRpc({
				_tag: "ListDaemonSessions",
				roots: false,
			});
			return shown(sessions.find((session) => session["id"] === id));
		};

		const check = async (
			label: string,
			expected: {
				readonly child: typeof WORKING;
				readonly childRuns: readonly { status: string }[];
				readonly root: typeof ROOT_WORKING | Record<string, unknown>;
				readonly rootInSession: typeof WORKING;
			},
		) => {
			const record: Record<string, unknown> = { label, expected };
			steps.push(record);
			// test-waits-allow polling: rows are coalesced up to a second after the change.
			await vi
				.waitFor(
					async () => {
						const child = childOf(viewer, root);
						record["childId"] = child ?? null;
						if (!child) throw new Error("no child yet");
						childView ??= await (async () => {
							const opened = await fixture.connect(
								undefined,
								undefined,
								"process-test",
								false,
							);
							await opened.open(child);
							record["childViewOpened"] = true;
							return opened;
						})();
						const childFrames = familyFrames(childView, child);
						record["childInView"] = childFrames.at(-1) ?? null;
						record["childInRootView"] =
							familyFrames(viewer, child).at(-1) ?? null;
						record["childListed"] = await listed(child);
						record["childRuns"] = runsOf(fixture, child);
						record["tab"] = shellFrames(tab, root).at(-1) ?? null;
						record["tabChildRows"] = shellFrames(tab, child).length;
						record["rootInSession"] = familyFrames(viewer, root).at(-1) ?? null;
						expect(record["childRuns"]).toEqual(expected.childRuns);
						const { tag: _tag, ...inView } = childFrames.at(-1) ?? {};
						expect(inView).toEqual(expected.child);
						const { tag: _rootTag, ...inRoot } =
							familyFrames(viewer, child).at(-1) ?? {};
						expect(inRoot).toEqual(expected.child);
						expect(record["childListed"]).toEqual(expected.child);
						const {
							tag: _t,
							sequence: _s,
							...tabRow
						} = (record["tab"] as Row | null) ?? {};
						expect(tabRow).toEqual(expected.root);
						expect(record["tabChildRows"]).toBe(0);
						const { tag: _r, ...rootInSession } =
							(record["rootInSession"] as Row | null) ?? {};
						expect(rootInSession).toEqual(expected.rootInSession);
					},
					{ timeout: 10_000 },
				)
				.catch((error: unknown) => {
					record["failure"] = String(error);
					failures.push(`${label}: ${String(error)}`);
				});
		};
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
		// The child's view opens before its prompt, so its working must arrive live.
		await step(
			"the child exists, its prompt not yet sent",
			31,
			{
				child: IDLE,
				childRuns: [],
				root: ROOT_WORKING,
				rootInSession: WORKING,
			},
			() => {
				turn = viewer
					.send(root, "Ask a subagent to summarise package.json")
					.catch((error: unknown) => error);
			},
		);
		await step("the child runs (after its first tool call)", 36, {
			child: WORKING,
			childRuns: [{ status: "running" }],
			root: ROOT_WORKING,
			rootInSession: WORKING,
		});
		await step("the child ended, the root still runs", 40, {
			child: IDLE,
			childRuns: [{ status: "completed" }],
			root: ROOT_WORKING,
			rootInSession: WORKING,
		});
		rmSync(hold);
		await turn;
		await check("the root's turn ended", {
			child: IDLE,
			childRuns: [{ status: "completed" }],
			root: {
				attention: expect.stringMatching(/^(idle|done-unread)$/),
				processing: false,
				label: "idle",
			},
			rootInSession: IDLE,
		});

		const child = childOf(viewer, root) ?? "";
		const childFrames = childView ? familyFrames(childView, child) : [];
		proof["childId"] = child;
		// The frames the child's session view received, and the activity values over time.
		proof["childViewFrames"] = childFrames;
		proof["childInRootViewFrames"] = familyFrames(viewer, child);
		proof["tabRootFrames"] = shellFrames(tab, root);
		proof["tabSnapshots"] = tab.frames.filter(
			({ message }) =>
				message["type"] === "shell" && message["_tag"] === "snapshot",
		).length;
		proof["childViewSnapshots"] = childFrames.filter(
			({ tag }) => tag === "snapshot",
		).length;
		proof["failures"] = failures;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
		expect(failures).toEqual([]);
		// 3. One snapshot (idle); working and then idle arrived as live upserts.
		expect(proof["childViewSnapshots"]).toBe(1);
		expect(childFrames[0]).toMatchObject({ tag: "snapshot", ...IDLE });
		expect(
			childFrames.some(
				({ tag, foreground }) => tag === "upsert" && foreground === "working",
			),
		).toBe(true);
		expect(childFrames.at(-1)).toMatchObject({ tag: "upsert", ...IDLE });
		// 4. The tab got one snapshot; every root change was a live upsert.
		expect(proof["tabSnapshots"]).toBe(1);
	});
});

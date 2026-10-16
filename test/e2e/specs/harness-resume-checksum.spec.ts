// A resumed subscription is checked, and the server wins (conduit-test-y7eo.9),
// through the built server and a real browser. One open tab rides a run of
// daemon restarts. While the daemon is down the store is changed directly, so on each
// restart the tab resumes into exactly those changes, as both the sidebar and
// the open transcript.
//
// Ways it can fail, each checked below:
// - a resume that passes its checksum re-sends the whole list or page anyway;
// - the checksum is missing, so a resume is never checked;
// - the client's ledger disagrees with the server's listing on an honest
//   resume, so every restart costs a snapshot (a false mismatch);
// - a change the browser lost goes unnoticed, sidebar or transcript, including
//   a lost update to a row it holds, where only the version differs;
// - a detected mismatch is not followed by a fresh snapshot, or the snapshot
//   is ignored because it is no newer than what the tab holds;
// - a catch-up over the page budget is sent as deltas;
// - a tab ahead of a server whose store went back keeps rows the server no
//   longer has;
// - a restart re-stamps every session for git that did not move, so the read
//   model counter advances with nothing to show (conduit-test-y7eo.16);
// - a branch switch or dirty file made while the daemon is down is never
//   stamped, because the server remembers the git it last published, so the
//   open tab keeps the old branch until a reload;
// - a folder that becomes a git repository while down is still published as
//   no git.
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --workers=1 harness-resume-checksum

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	EventPayloadMap,
	LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const SESSION = "resume-check";
const OTHER = "resume-other";
const DETAIL = `session-detail/${SESSION}`;
const START = Date.UTC(2026, 9, 1);
const MISMATCH = "[resume] checksum mismatch";
// Over the page budget: 30 turns of ~20 KB replies are 60 messages, ~600 KB.
const OVER_BUDGET_TURNS = 30;

const replyEnd = (tag: string, turn: number) => `END-OF-${tag}-${turn}.`;
const prose = (label: string, bytes: number) =>
	Array.from(
		{ length: Math.ceil(bytes / 64) },
		(_, line) => `${label} line ${line}: the quick brown fox jumps over it.`,
	).join("\n");

const event =
	(sessionId: string, createdAt: number) =>
	<T extends LiveEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, sessionId, data, { provider: "claude", createdAt });

/** One prompt and its reply. `phase` keeps every seeding later than the last. */
const turns = (
	sessionId: string,
	phase: number,
	tag: string,
	count: number,
	reply: (turn: number) => string,
): CanonicalEvent[] =>
	Array.from({ length: count }, (_, turn) => {
		const at = START + phase * 10_000_000 + turn * 1000;
		const user = `${sessionId}-${tag}-u${turn}`;
		const assistant = `${sessionId}-${tag}-a${turn}`;
		const prompt = event(sessionId, at);
		const answer = event(sessionId, at + 500);
		return [
			prompt("message.created", { messageId: user, role: "user", sessionId }),
			prompt("text.delta", {
				messageId: user,
				partId: `${user}-0`,
				text: `Prompt ${tag} ${turn}.`,
			}),
			answer("message.created", {
				messageId: assistant,
				role: "assistant",
				sessionId,
			}),
			answer("text.delta", {
				messageId: assistant,
				partId: `${assistant}-text`,
				text: `${reply(turn)}\n${replyEnd(tag, turn)}`,
			}),
			answer("turn.completed", {
				messageId: assistant,
				tokens: { input: 10, output: 10 },
				duration: 1000,
			}),
		];
	}).flat();

const created = (sessionId: string, title: string): CanonicalEvent =>
	event(sessionId, START)("session.created", {
		sessionId,
		title,
		provider: "claude",
		providerSessionId: sessionId,
	});

const renamed = (phase: number, title: string): CanonicalEvent =>
	event(SESSION, START + phase * 10_000_000)("session.renamed", {
		sessionId: SESSION,
		title,
	});

const seed = (filename: string, events: readonly CanonicalEvent[]) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([...events], { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

interface SourceReads {
	readonly reads: Record<string, number>;
}

/** Reads per source since the server started, once it has flushed past now. */
const serverReads = async (file: string) => {
	const asked = Date.now();
	const metrics = () =>
		JSON.parse(readFileSync(file, "utf8")) as {
			readonly flushedAt: number;
			readonly sources: Record<string, SourceReads>;
		};
	await expect.poll(() => metrics().flushedAt).toBeGreaterThan(asked);
	const { sources } = metrics();
	return {
		shell: sources["shell"]?.reads ?? {},
		detail: sources[DETAIL]?.reads ?? {},
	};
};

/** Every value anywhere in a frame that matches `match`. */
const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};

const idOf = (value: unknown) =>
	typeof value === "object" && value !== null && "id" in value
		? value.id
		: undefined;
const tagOf = (value: unknown) =>
	typeof value === "object" && value !== null && "_tag" in value
		? value._tag
		: undefined;

/** The transcript's text, without the "↓ Latest" button, which shows or not
 * depending on where the tab happens to be scrolled. */
const transcriptOf = (page: Page) =>
	page.locator("#messages").evaluate((messages: HTMLElement) => {
		const button = messages.querySelector<HTMLElement>("#scroll-btn");
		if (!button) return messages.innerText;
		const display = button.style.display;
		button.style.display = "none";
		try {
			return messages.innerText;
		} finally {
			button.style.display = display;
		}
	});
const sidebarOf = (page: Page) =>
	page.locator("[data-session-id] .session-item-title").allTextContents();

test.describe.configure({ retries: 0 });

test("a resume is checked against the server, and the server wins", async ({
	browser,
	harness,
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"The wire is the same on every device; desktop shows the sidebar beside the transcript.",
	);
	test.setTimeout(300_000);
	const store = harness.projectStorePath();
	const counter = () => {
		const db = new DatabaseSync(store, { readOnly: true });
		try {
			return (
				db.prepare("SELECT value FROM read_model_counter").get() as {
					value: number;
				}
			).value;
		} finally {
			db.close();
		}
	};
	// Git in the project folder, without the runner's or the user's settings.
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=conduit",
				"-c",
				"user.email=conduit@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{
				cwd: harness.projectDir,
				env: Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => !key.startsWith("GIT_"),
					),
				),
			},
		);

	await harness.terminate();
	await seed(store, [
		created(SESSION, "Resume check"),
		created(OTHER, "Resume other"),
		...turns(SESSION, 1, "base", 2, (turn) => `Base reply ${turn}.`),
		...turns(OTHER, 1, "other", 1, () => "Other reply."),
	]);
	await harness.restart({ keepPort: true, skipBrowserProbe: true });

	const received: { readonly at: number; readonly text: string }[] = [];
	page.on("websocket", (socket) =>
		socket.on("framereceived", ({ payload }) =>
			received.push({ at: Date.now(), text: payload.toString() }),
		),
	);
	type Checksum = { readonly hash: number; readonly rows: number };
	const mismatches: Promise<{
		readonly server: Checksum;
		readonly client: Checksum;
	}>[] = [];
	page.on("console", (message) => {
		const detail = message.args()[1];
		if (message.text().includes(MISMATCH) && detail)
			mismatches.push(detail.jsonValue());
	});
	await new AppPage(page).goto(
		`${harness.baseUrl}/s/${SESSION}?p=process-test`,
	);
	const title = page.locator(
		`[data-session-id="${SESSION}"] .session-item-title`,
	);
	await expect(title).toHaveText("Resume check", { timeout: 30_000 });
	await expect(page.locator("#messages")).toContainText(replyEnd("base", 1));

	const cold = async () => {
		const context = await browser.newContext({
			viewport: testInfo.project.use.viewport ?? null,
		});
		const fresh = await context.newPage();
		await new AppPage(fresh).goto(
			`${harness.baseUrl}/s/${SESSION}?p=process-test`,
		);
		await expect(
			fresh.locator(`[data-session-id="${SESSION}"] .session-item-title`),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			fresh.locator("#messages .msg-assistant").first(),
		).toBeVisible();
		const view = {
			transcript: await transcriptOf(fresh),
			sidebar: await sidebarOf(fresh),
		};
		await context.close();
		return view;
	};

	/**
	 * Stop the daemon, change the store, start it again, and wait for the tab
	 * to show `shown`. Reports what the tab was sent and read for it.
	 */
	const restartWith = async (
		name: string,
		change: () => Promise<void>,
		shown: () => Promise<void>,
	) => {
		await harness.terminate();
		await change();
		const counterAtStop = counter();
		const metricsFile = join(harness.root, `server-metrics-${name}.json`);
		const from = Date.now();
		const mismatchesBefore = mismatches.length;
		await harness.restart({
			keepPort: true,
			metricsFile,
			skipBrowserProbe: true,
		});
		await shown();
		await page.waitForTimeout(1_000);
		const reads = await serverReads(metricsFile);
		const frames = received.filter(({ at }) => at >= from);
		const values = frames.flatMap(({ text }) => {
			try {
				return [JSON.parse(text) as unknown];
			} catch {
				return [];
			}
		});
		const tagged = (tag: string) => (value: object) =>
			"_tag" in value && value._tag === tag;
		const snapshots = values
			.flatMap((value) => find(value, tagged("snapshot")))
			.map((snapshot): readonly unknown[] =>
				"rows" in snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [],
			);
		const view = {
			transcript: await transcriptOf(page),
			sidebar: await sidebarOf(page),
		};
		const coldView = await cold();
		if (view.transcript !== coldView.transcript)
			writeFileSync(
				testInfo.outputPath(`${name}-transcripts.json`),
				JSON.stringify({ tab: view.transcript, cold: coldView.transcript }),
			);
		return {
			name,
			reads,
			counterMoved: counter() !== counterAtStop,
			frames: frames.length,
			bytes: frames.reduce(
				(total, { text }) => total + Buffer.byteLength(text),
				0,
			),
			// Family, approvals and todos rebase on every resume; these two do
			// only when they must. The sidebar's rows name every root session.
			snapshots: {
				shell: snapshots.filter((rows) =>
					rows.some((row) => idOf(row) === OTHER),
				).length,
				detail: snapshots.filter((rows) =>
					rows.some((row) => tagOf(row) === "message" || tagOf(row) === "part"),
				).length,
			},
			checkedSyncs: values.flatMap((value) =>
				find(
					value,
					(found) => tagged("synchronized")(found) && "checksum" in found,
				),
			).length,
			resentBase: frames.some(({ text }) => text.includes(replyEnd("base", 0))),
			mismatches: mismatches.length - mismatchesBefore,
			transcriptEqualsCold: view.transcript === coldView.transcript,
			sidebarEqualsCold:
				JSON.stringify(view.sidebar) === JSON.stringify(coldView.sidebar),
		};
	};

	// A. Restart with changes made while away: only they arrive, and both
	// subscriptions pass the checksum.
	const changesOnly = await restartWith(
		"changes-only",
		() =>
			seed(
				store,
				turns(SESSION, 2, "away", 1, () => "Away reply."),
			),
		() => expect(page.locator("#messages")).toContainText(replyEnd("away", 0)),
	);

	// B. The tab drops one transcript change it was sent. The checksum after
	// the catch-up disowns its view, and a fresh snapshot replaces it.
	await page.evaluate(() => {
		window.__conduitDropChange = (envelope) =>
			"item" in envelope &&
			typeof envelope.item === "object" &&
			envelope.item !== null &&
			"_tag" in envelope.item &&
			envelope.item._tag === "part" &&
			JSON.stringify(envelope.item).includes("Dropped reply");
	});
	const droppedPart = await restartWith(
		"dropped-part",
		() =>
			seed(
				store,
				turns(SESSION, 3, "dropped", 1, () => "Dropped reply."),
			),
		async () => {
			await expect.poll(() => mismatches.length).toBe(1);
			await expect(page.locator("#messages")).toContainText(
				replyEnd("dropped", 0),
			);
		},
	);
	const flagCleared = await page.evaluate(
		() => window.__conduitDropChange === undefined,
	);

	// C. The tab drops one sidebar change: the rename of the open session.
	await page.evaluate((id) => {
		window.__conduitDropChange = (envelope) =>
			"item" in envelope &&
			typeof envelope.item === "object" &&
			envelope.item !== null &&
			"id" in envelope.item &&
			envelope.item.id === id &&
			!("_tag" in envelope.item);
	}, SESSION);
	const droppedRow = await restartWith(
		"dropped-row",
		() => seed(store, [renamed(4, "Resume check renamed")]),
		async () => {
			await expect.poll(() => mismatches.length).toBe(2);
			await expect(title).toHaveText("Resume check renamed");
		},
	);

	// C2. The tab drops an update to a part it already holds: the row count
	// agrees, so only the versions can catch it.
	const updated = `${SESSION}-away-a0`;
	await page.evaluate((partId) => {
		window.__conduitDropChange = (envelope) =>
			"item" in envelope &&
			typeof envelope.item === "object" &&
			envelope.item !== null &&
			"part" in envelope.item &&
			typeof envelope.item.part === "object" &&
			envelope.item.part !== null &&
			"id" in envelope.item.part &&
			envelope.item.part.id === partId;
	}, `${updated}-text`);
	const droppedUpdate = await restartWith(
		"dropped-part-update",
		() =>
			seed(store, [
				event(SESSION, START + 45_000_000)("text.delta", {
					messageId: updated,
					partId: `${updated}-text`,
					text: " Appended while away.",
				}),
			]),
		async () => {
			await expect.poll(() => mismatches.length).toBe(3);
			// The hash caught it, not the count.
			const caught = await mismatches[2];
			if (!caught) throw new Error("no third mismatch");
			const { server, client } = caught;
			expect(server.rows).toBe(client.rows);
			expect(server.hash).not.toBe(client.hash);
			await expect(page.locator("#messages")).toContainText(
				"Appended while away.",
			);
		},
	);

	// D. More changed while away than one page holds: a snapshot, not deltas.
	const overBudget = await restartWith(
		"over-budget",
		() =>
			seed(
				store,
				turns(SESSION, 5, "budget", OVER_BUDGET_TURNS, (turn) =>
					prose(`Budget ${turn}`, 20_000),
				),
			),
		() =>
			expect(page.locator("#messages")).toContainText(
				replyEnd("budget", OVER_BUDGET_TURNS - 1),
			),
	);

	// E. The store goes back: the tab is ahead of the server, and the server's
	// snapshot replaces what the tab held past it.
	const backup = join(harness.root, "rollback");
	mkdirSync(backup, { recursive: true });
	const files = ["", "-wal", "-shm"].map((suffix) => ({
		live: `${store}${suffix}`,
		kept: join(backup, `events.db${suffix}`),
	}));
	const ahead = await restartWith(
		"ahead-setup",
		async () => {
			for (const { live, kept } of files)
				if (existsSync(live)) copyFileSync(live, kept);
			await seed(store, [
				...turns(SESSION, 6, "ahead", 1, () => "Ahead reply."),
				renamed(6, "Resume check ahead"),
			]);
		},
		async () => {
			await expect(title).toHaveText("Resume check ahead");
			await expect(page.locator("#messages")).toContainText(
				replyEnd("ahead", 0),
			);
		},
	);
	const behind = await restartWith(
		"ahead-of-server",
		async () => {
			for (const { live, kept } of files) {
				rmSync(live, { force: true });
				if (existsSync(kept)) copyFileSync(kept, live);
			}
		},
		async () => {
			await expect(title).toHaveText("Resume check renamed");
			await expect(page.locator("#messages")).not.toContainText(
				replyEnd("ahead", 0),
			);
		},
	);

	// F. Git moves only while the daemon is down, and the open tab is never
	// reloaded. The folder becomes a repository on main; then a restart with
	// nothing changed; then a switch to a new branch with an untracked file.
	const branch = page.locator(
		'[data-testid="composer-checkout"] [data-part="branch"]',
	);
	const dirty = page.locator(
		'[data-testid="composer-checkout"] [data-part="dirty"]',
	);
	const gitInit = await restartWith(
		"git-init",
		async () => {
			git("init", "-q", "-b", "main");
			git("commit", "-q", "--allow-empty", "-m", "init");
		},
		async () => {
			await expect(branch).toHaveText("main", { timeout: 30_000 });
			await expect(dirty).toHaveCount(0);
		},
	);
	let unchangedFrom = 0;
	const gitUnchanged = await restartWith(
		"git-unchanged",
		async () => {
			unchangedFrom = Date.now();
		},
		async () => {
			await expect
				.poll(
					() =>
						received.filter(
							({ at, text }) =>
								at >= unchangedFrom &&
								text.includes('"_tag":"synchronized"') &&
								text.includes('"checksum"'),
						).length,
					{ timeout: 30_000 },
				)
				.toBeGreaterThanOrEqual(2);
			// The counter is read next, so the refresh that must not move it
			// has to have read the folder first.
			await expect
				.poll(
					() =>
						(
							JSON.parse(
								readFileSync(
									join(harness.root, "server-metrics-git-unchanged.json"),
									"utf8",
								),
							) as { gitRefreshes: { read: number }[] }
						).gitRefreshes.some(({ read }) => read > 0),
					{ timeout: 30_000 },
				)
				.toBe(true);
		},
	);
	const gitAway = await restartWith(
		"git-away",
		async () => {
			git("checkout", "-q", "-b", "away");
			writeFileSync(join(harness.projectDir, "away.txt"), "while down\n");
		},
		async () => {
			await expect(branch).toHaveText("away", { timeout: 30_000 });
			await expect(dirty).toBeVisible();
		},
	);

	const report = {
		schema: 1,
		project: testInfo.project.name,
		recordedAt: new Date().toISOString(),
		phases: [
			changesOnly,
			droppedPart,
			droppedRow,
			droppedUpdate,
			overBudget,
			ahead,
			behind,
			gitInit,
			gitUnchanged,
			gitAway,
		],
		flagCleared,
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`resume-checksum.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("resume-checksum-report", { path: output });

	// Every phase ends where a cold open does.
	for (const phase of report.phases)
		expect(phase, phase.name).toMatchObject({
			transcriptEqualsCold: true,
			sidebarEqualsCold: true,
		});
	// A: changes only, and both resumes are checked and pass.
	expect(changesOnly).toMatchObject({
		snapshots: { shell: 0, detail: 0 },
		checkedSyncs: 2,
		resentBase: false,
		mismatches: 0,
	});
	expect(changesOnly.reads.shell).not.toHaveProperty("base");
	expect(changesOnly.reads.detail).not.toHaveProperty("base");
	expect(changesOnly.reads.shell["resume"]).toBe(1);
	expect(changesOnly.reads.detail["resume"]).toBe(1);
	// B and C: each lost change is caught once, and only its subscription is
	// opened again cold; the other passes its check.
	expect(droppedPart).toMatchObject({
		mismatches: 1,
		snapshots: { shell: 0, detail: 1 },
	});
	expect(droppedPart.reads.detail["base"]).toBe(1);
	expect(droppedPart.reads.shell).not.toHaveProperty("base");
	expect(flagCleared).toBe(true);
	expect(droppedRow).toMatchObject({
		mismatches: 1,
		snapshots: { shell: 1, detail: 0 },
	});
	expect(droppedRow.reads.shell["base"]).toBe(1);
	expect(droppedRow.reads.detail).not.toHaveProperty("base");
	expect(droppedUpdate).toMatchObject({
		mismatches: 1,
		snapshots: { shell: 0, detail: 1 },
	});
	expect(droppedUpdate.reads.detail["base"]).toBe(1);
	expect(droppedUpdate.reads.shell).not.toHaveProperty("base");
	// D: the transcript falls back to a snapshot without a mismatch; the
	// sidebar is never paged, so it still catches up.
	expect(overBudget).toMatchObject({
		mismatches: 0,
		snapshots: { shell: 0, detail: 1 },
	});
	expect(overBudget.reads.detail).toMatchObject({ resume: 1, base: 1 });
	expect(overBudget.reads.shell).not.toHaveProperty("base");
	// E: ahead of the server, both subscriptions take a snapshot.
	expect(ahead).toMatchObject({
		mismatches: 0,
		snapshots: { shell: 0, detail: 0 },
	});
	expect(behind).toMatchObject({
		mismatches: 0,
		snapshots: { shell: 1, detail: 1 },
	});
	expect(behind.reads.shell).toMatchObject({ resume: 1, base: 1 });
	expect(behind.reads.detail).toMatchObject({ resume: 1, base: 1 });
	// F: git that moved while down is stamped on the first refresh and reaches
	// the open tab as a change; git that did not move stamps nothing.
	for (const moved of [gitInit, gitAway])
		expect(moved, moved.name).toMatchObject({
			counterMoved: true,
			mismatches: 0,
			snapshots: { shell: 0, detail: 0 },
		});
	expect(gitUnchanged).toMatchObject({
		counterMoved: false,
		mismatches: 0,
		snapshots: { shell: 0, detail: 0 },
		checkedSyncs: 2,
	});
	for (const phase of [gitInit, gitUnchanged, gitAway]) {
		expect(phase.reads.shell, phase.name).not.toHaveProperty("base");
		expect(phase.reads.detail, phase.name).not.toHaveProperty("base");
	}
});

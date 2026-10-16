import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: another project's row misses live activity; its idle status
// fails to invalidate the daemon list; a relay rebuild drops that activity;
// ending a task never refreshes the final row. The SDK gate holds the task
// after its foreground result, so these assertions do not race a real shell.
test.use({ harnessOptions: { restartProof: true } });
test.beforeEach(({ isMobile }) => {
	test.skip(isMobile, "The cross-project sidebar is checked on desktop");
});

type Observation = {
	step: string;
	attention: string | null;
	pass: boolean;
};

async function attention(row: Locator): Promise<string | null> {
	const label = await row.getAttribute("aria-label", { timeout: 1000 });
	if (label === null) return null;
	if (label.startsWith("Monitoring,")) return "monitoring";
	if (label.startsWith("Done, unread,")) return "done-unread";
	if (label.startsWith("Working,")) return "working";
	if (label.startsWith("Failed,")) return "error";
	return "idle";
}

async function exercise(
	page: Page,
	harness: ProcessHarness,
	testInfo: TestInfo,
	rebuild: boolean,
): Promise<void> {
	const steps: Observation[] = [
		{ step: "idle-before-turn", attention: null, pass: false },
		{ step: "turn-ended-task-live", attention: null, pass: false },
		...(rebuild
			? [{ step: "relay-rebuilt-task-live", attention: null, pass: false }]
			: []),
		{ step: "task-ended", attention: null, pass: false },
	];
	let current = 0;
	let row: Locator | undefined;
	let attachedToA = false;
	const artifact = resolve(
		"test-results",
		rebuild
			? "82tn19-session-activity-rebuild.json"
			: "82tn19-cross-project-monitoring.json",
	);
	const record = async () => {
		const step = steps[current];
		if (!step || !row) throw new Error("Missing observation step");
		step.attention = await attention(row);
		step.pass = true;
		current += 1;
	};
	try {
		const control = await harness.connect();
		const sessionA = await control.createSession("Project A observer");
		const folderB = join(harness.root, "project-b");
		mkdirSync(folderB);
		const { savedSlug: slugB } = await Effect.runPromise(
			control.rpc.SaveProject({ title: "Project B", folders: [folderB] }),
		);
		if (!slugB) throw new Error("SaveProject omitted Project B's slug");
		const driverB = await harness.connect(undefined, undefined, slugB);
		const sessionB = await driverB.createSession("Project B background shell");
		const projectAUrl = `${harness.baseUrl}/s/${sessionA}`;
		await new AppPage(page).goto(projectAUrl);
		const observedRow = page.locator(
			`#session-list [data-session-id="${sessionB}"]`,
		);
		row = observedRow;
		await expect(page.getByTestId("session-scope-chip")).toHaveText(
			"All projects",
		);
		await expect(row).toBeVisible();
		await expect.poll(() => attention(observedRow)).toBe("idle");
		attachedToA = page.url() === projectAUrl;
		expect(attachedToA).toBe(true);
		await record();

		const result = await driverB.send(sessionB, "upgrade-background-work");
		expect(result.done["status"]).toBe("idle");
		// No browser navigation or manual list refresh after the turn. A's
		// cross-project row must react to the daemon's sessionsRevision signal.
		await expect(row).toHaveAttribute("aria-label", /^Monitoring,/, {
			timeout: 5000,
		});
		expect(page.url()).toBe(projectAUrl);
		await record();

		if (rebuild) {
			const readB = async () => {
				const response = await Effect.runPromise(
					control.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
				);
				const session = response.sessions.find((item) => item.id === sessionB);
				if (!session)
					throw new Error("Daemon list omitted Project B's session");
				return session;
			};
			const before = await readB();
			expect(before).toMatchObject({
				attention: "monitoring",
				backgroundWork: "monitoring",
				status: "idle",
			});
			expect(before.backgroundTasks).toHaveLength(1);
			const extra = join(harness.root, "project-b-extra");
			mkdirSync(extra);
			// Changing the folder set enters projectRegistry.replaceRelay.
			// Keeping the primary folder retains the live Claude process.
			const saved = await Effect.runPromise(
				control.rpc.SaveProject({ slug: slugB, folders: [folderB, extra] }),
			);
			expect(
				saved.projects.find((project) => project.slug === slugB),
			).toMatchObject({ folders: [folderB, extra] });
			// Acquire a new relay subscription and read the daemon separately.
			// A cached browser row alone would not prove rebuild survival.
			const rebuilt = await harness.connect(undefined, undefined, slugB);
			const shell = await rebuilt.waitFor(
				(message) =>
					message["type"] === "session_row" && message["id"] === sessionB,
			);
			expect(shell).toMatchObject({
				attention: "monitoring",
				backgroundWork: "monitoring",
				backgroundTasks: before.backgroundTasks,
			});
			expect(await readB()).toMatchObject({
				attention: "monitoring",
				backgroundWork: "monitoring",
				backgroundTasks: before.backgroundTasks,
			});
			await expect(row).toHaveAttribute("aria-label", /^Monitoring,/);
			expect(page.url()).toBe(projectAUrl);
			await record();
		}

		writeFileSync(join(harness.root, "release-upgrade-background"), "release");
		await expect(row).toHaveAttribute("aria-label", /^Done, unread,/, {
			timeout: 5000,
		});
		expect(page.url()).toBe(projectAUrl);
		await record();
	} finally {
		const pending = steps[current];
		if (pending && row)
			pending.attention = await attention(row).catch(() => null);
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(
			artifact,
			`${JSON.stringify(
				{
					project: "B",
					observedFrom: "A",
					attachedToA,
					attentionSequence: steps.flatMap((step) =>
						step.attention === null ? [] : [step.attention],
					),
					steps,
					pass: steps.every((step) => step.pass),
				},
				null,
				2,
			)}\n`,
		);
		await testInfo.attach(basename(artifact), {
			path: artifact,
			contentType: "application/json",
		});
	}
}

test("another project's background shell updates A's sidebar without opening B", async ({
	page,
	harness,
}, testInfo) => {
	await exercise(page, harness, testInfo, false);
});

test("Session Activity survives a project-folder relay rebuild", async ({
	page,
	harness,
}, testInfo) => {
	await exercise(page, harness, testInfo, true);
});

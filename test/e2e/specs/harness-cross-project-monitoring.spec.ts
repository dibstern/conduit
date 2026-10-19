import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: another project's row misses live activity; its idle status
// misses its owning project; a relay rebuild drops that activity;
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
	const shellRequests: {
		socket: number;
		requestId: string;
		payload: unknown;
	}[] = [];
	const shellUpserts: {
		socket: number;
		requestId: string;
		sessionId: string;
		owner: string;
		version: number;
		attention: unknown;
	}[] = [];
	let browseRefetchCount = 0;
	let existingShell: (typeof shellRequests)[number] | undefined;
	let backgroundSessionId: string | undefined;
	let backgroundOwner: string | undefined;
	let socketSequence = 0;
	const frames = (payload: string | Buffer): Record<string, unknown>[] => {
		const parsed: unknown = JSON.parse(payload.toString());
		return (Array.isArray(parsed) ? parsed : [parsed]).filter(
			(frame): frame is Record<string, unknown> =>
				typeof frame === "object" && frame !== null,
		);
	};
	page.on("websocket", (socket) => {
		const identity = ++socketSequence;
		socket.on("framesent", ({ payload }) => {
			for (const frame of frames(payload)) {
				if (frame["_tag"] !== "Request") continue;
				if (frame["tag"] === "ListDaemonSessions") browseRefetchCount++;
				if (frame["tag"] === "SubscribeShell")
					shellRequests.push({
						socket: identity,
						requestId: String(frame["id"]),
						payload: frame["payload"],
					});
			}
		});
		socket.on("framereceived", ({ payload }) => {
			for (const frame of frames(payload)) {
				if (frame["_tag"] !== "Chunk" || !Array.isArray(frame["values"]))
					continue;
				const requestId = String(frame["requestId"]);
				if (
					!shellRequests.some(
						(request) =>
							request.socket === identity && request.requestId === requestId,
					)
				)
					continue;
				for (const value of frame["values"]) {
					if (
						typeof value !== "object" ||
						value === null ||
						value._tag !== "upsert"
					)
						continue;
					const item: unknown = value.item;
					if (
						typeof item !== "object" ||
						item === null ||
						!("id" in item) ||
						!("projectSlug" in item)
					)
						continue;
					shellUpserts.push({
						socket: identity,
						requestId,
						sessionId: String(item.id),
						owner: String(item.projectSlug),
						version: Number(value.sequence),
						attention: "attention" in item ? item.attention : undefined,
					});
				}
			}
		});
	});
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
		backgroundOwner = slugB;
		const driverB = await harness.connect(undefined, undefined, slugB);
		const sessionB = await driverB.createSession("Project B background shell");
		backgroundSessionId = sessionB;
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
		expect(shellRequests).toHaveLength(1);
		existingShell = shellRequests[0];
		expect(existingShell?.payload).not.toHaveProperty("projectSlug");
		expect(browseRefetchCount).toBe(0);

		const result = await driverB.send(sessionB, "upgrade-background-work");
		expect(result.done["status"]).toBe("idle");
		// B's transition must use A's existing shell request, without a browse RPC.
		await expect(row).toHaveAttribute("aria-label", /^Monitoring,/, {
			timeout: 5000,
		});
		expect(page.url()).toBe(projectAUrl);
		await expect
			.poll(() =>
				shellUpserts.some(
					(upsert) =>
						upsert.sessionId === sessionB &&
						upsert.owner === slugB &&
						upsert.attention === "monitoring" &&
						upsert.socket === existingShell?.socket &&
						upsert.requestId === existingShell?.requestId &&
						upsert.version > 0,
				),
			)
			.toBe(true);
		expect(shellRequests).toHaveLength(1);
		expect(browseRefetchCount).toBe(0);
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
		expect(shellRequests).toHaveLength(1);
		expect(browseRefetchCount).toBe(0);
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
					shellRequest: existingShell,
					backgroundSession: {
						id: backgroundSessionId,
						owner: backgroundOwner,
					},
					backgroundUpserts: shellUpserts.filter(
						(upsert) => upsert.sessionId === backgroundSessionId,
					),
					browseRefetchCount,
					shellRequestCount: shellRequests.length,
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

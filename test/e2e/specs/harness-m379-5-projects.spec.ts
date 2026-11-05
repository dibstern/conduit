import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// m379.5: the tab is never "in" a project. Each scenario leaves its evidence at
// test-results/m379-5-<scenario>.json, written even when a step fails.
const model = {
	providerId: "claude",
	modelId: "sonnet",
	variant: "",
	contextWindow: "200k",
} as const;

async function addProject(harness: ProcessHarness, name: string) {
	const folder = join(harness.root, name);
	mkdirSync(folder, { recursive: true });
	const { savedSlug } = await harness.requestRpc({
		_tag: "SaveProject",
		folders: [folder],
		title: name,
	});
	return savedSlug;
}

async function addSession(
	harness: ProcessHarness,
	projectSlug: string,
	title: string,
) {
	const { sessionId } = await harness.requestRpc({
		_tag: "CreateSession",
		projectSlug,
		originId: "m379-5",
		providerId: "claude",
		permissionMode: "full",
		model,
		title,
	});
	return sessionId;
}

/** Counts every request the page sends, by tag. */
function countRequests(page: Page) {
	const counts: Record<string, number> = {};
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			const parsed: unknown = JSON.parse(payload.toString());
			for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
				if (frame?._tag !== "Request") continue;
				const tag = String(frame.tag);
				counts[tag] = (counts[tag] ?? 0) + 1;
			}
		});
	});
	return counts;
}

function evidence(scenario: string, body: Record<string, unknown>) {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		`test-results/m379-5-${scenario}.json`,
		`${JSON.stringify({ bead: "conduit-test-m379.5", scenario, ...body }, null, 2)}\n`,
	);
}

const row = (page: Page, id: string) =>
	page.locator(`#session-list [data-session-id="${id}"]`);

async function expectOpen(page: Page, id: string, title: string) {
	await expect(page).toHaveURL(new RegExp(`/s/${id}(?:\\?.*)?$`), {
		timeout: 20_000,
	});
	await expect(page.getByTestId("session-bar-title")).toHaveText(title, {
		timeout: 20_000,
	});
}

// Failure mode 1: moving between sessions of two projects clears or reloads the sidebar.
test("moving between sessions of two projects keeps the sidebar", async ({
	page,
	harness,
}) => {
	const steps: Record<string, unknown> = {};
	try {
		const slugB = await addProject(harness, "project-b");
		const a1 = await addSession(harness, "process-test", "Alpha in A");
		const b1 = await addSession(harness, slugB, "Alpha in B");
		const a2 = await addSession(harness, "process-test", "Gamma in A");
		const requests = countRequests(page);
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}/s/${a1}`);
		await expectOpen(page, a1, "Alpha in A");
		await expect(row(page, a2)).toBeVisible({ timeout: 20_000 });

		await page.locator("#session-search-input").fill("Alpha");
		await expect(row(page, a2)).toHaveCount(0, { timeout: 20_000 });
		await expect(row(page, b1)).toBeVisible();
		const shellBefore = requests["SubscribeShell"] ?? 0;
		await page.evaluate(() => {
			const removed: string[] = [];
			(window as unknown as { m3795Removed: string[] }).m3795Removed = removed;
			new MutationObserver((records) => {
				for (const record of records)
					for (const node of record.removedNodes) {
						if (!(node instanceof Element)) continue;
						for (const el of [node, ...node.querySelectorAll("*")]) {
							const id = el.getAttribute("data-session-id");
							if (id) removed.push(id);
						}
					}
			}).observe(document.querySelector("#session-list") as Element, {
				childList: true,
				subtree: true,
			});
		});

		const hops = [
			[b1, "Alpha in B"],
			[a1, "Alpha in A"],
			[b1, "Alpha in B"],
		] as const;
		for (const [id, title] of hops) {
			await row(page, id).locator(".session-item-title").click();
			await expectOpen(page, id, title);
		}
		steps["removedRows"] = await page.evaluate(
			() => (window as unknown as { m3795Removed: string[] }).m3795Removed,
		);
		steps["searchValue"] = await page
			.locator("#session-search-input")
			.inputValue();
		steps["gammaShown"] = await row(page, a2).count();
		steps["shellSubscribes"] = (requests["SubscribeShell"] ?? 0) - shellBefore;
		steps["requests"] = requests;
		expect(steps["searchValue"]).toBe("Alpha");
		expect(steps["gammaShown"]).toBe(0);
		expect(steps["removedRows"]).toEqual([]);
		expect(steps["shellSubscribes"]).toBe(0);
		expect(requests["SubscribeShell"]).toBe(1);
		steps["passed"] = true;
	} finally {
		evidence("sidebar", steps);
	}
});

// Failure modes 3, 4, 5: old links, a wrong slug, a removed project, each a cold first load.
test("old /p/<slug>/s/<id> links open the session", async ({
	page,
	harness,
}) => {
	const steps: Record<string, unknown> = {};
	try {
		const slugB = await addProject(harness, "project-b");
		const slugC = await addProject(harness, "project-c");
		const b1 = await addSession(harness, slugB, "Linked in B");
		const c1 = await addSession(harness, slugC, "Gone with C");
		await harness.requestRpc({ _tag: "RemoveProject", slug: slugC });
		const app = new AppPage(page);

		await app.goto(`${harness.baseUrl}/p/${slugB}/s/${b1}`);
		await expectOpen(page, b1, "Linked in B");
		steps["ownSlug"] = new URL(page.url()).pathname;

		await app.goto(`${harness.baseUrl}/p/process-test/s/${b1}`);
		await expectOpen(page, b1, "Linked in B");
		steps["wrongSlug"] = new URL(page.url()).pathname;

		await app.goto(`${harness.baseUrl}/p/${slugC}/s/${c1}`);
		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
		steps["removedProjectSession"] = page.url();

		await app.goto(`${harness.baseUrl}/p/${slugC}`);
		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
		await expect(page.locator("#session-list")).toBeVisible();
		steps["removedProjectLink"] = page.url();
		steps["passed"] = true;
	} finally {
		evidence("links", steps);
	}
});

// Failure modes 6, 7, 8: terminals follow the shown session, not the filter; a removed
// project's terminal leaves an open tab; a new session takes the shown session's project.
test("terminals and new sessions follow the shown session, not the filter", async ({
	page,
	harness,
}) => {
	const steps: Record<string, unknown> = {};
	try {
		const slugB = await addProject(harness, "project-b");
		const a1 = await addSession(harness, "process-test", "Terminal A");
		const b1 = await addSession(harness, slugB, "Terminal B");
		const onA = await harness.connect(a1, undefined, "process-test", false);
		const onB = await harness.connect(b1, undefined, slugB, false);
		const ptyA = (await onA.createPty()).id;
		const ptyB = (await onB.createPty()).id;
		await onA.close();
		await onB.close();
		const tab = (id: string) =>
			page.locator(`[role="tab"][data-pty-id="${id}"]`);
		const app = new AppPage(page);

		await app.goto(`${harness.baseUrl}/s/${a1}?p=${slugB}`);
		await expectOpen(page, a1, "Terminal A");
		await app.terminalToggleBtn.click();
		await expect(tab(ptyA)).toBeVisible({ timeout: 20_000 });
		steps["filteredToBShowsB"] = await tab(ptyB).count();
		expect(steps["filteredToBShowsB"]).toBe(0);

		await page.locator("#new-session-btn").click();
		await expect(page).toHaveURL(/\/draft\//);
		steps["draftProject"] = new URL(page.url()).searchParams.get("project");
		expect(steps["draftProject"]).toBe("process-test");

		await app.goto(`${harness.baseUrl}/s/${b1}`);
		await expectOpen(page, b1, "Terminal B");
		if (!(await tab(ptyB).isVisible())) await app.terminalToggleBtn.click();
		await expect(tab(ptyB)).toBeVisible({ timeout: 20_000 });
		await harness.requestRpc({ _tag: "RemoveProject", slug: slugB });
		await expect.poll(() => new URL(page.url()).pathname).toBe("/");
		await expect(tab(ptyB)).toHaveCount(0, { timeout: 20_000 });
		steps["removedTerminalLeft"] = true;
		steps["passed"] = true;
	} finally {
		evidence("terminals", steps);
	}
});

// Failure mode 9: the device's saved sidebar holds only one project's rows, so a reload
// first paints a sidebar missing every other project's sessions.
test("a reload first paints every project's saved sidebar rows", async ({
	page,
	harness,
}) => {
	const steps: Record<string, unknown> = {};
	try {
		const slugB = await addProject(harness, "project-b");
		const a1 = await addSession(harness, "process-test", "Saved in A");
		const b1 = await addSession(harness, slugB, "Saved in B");
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}/s/${a1}`);
		await expectOpen(page, a1, "Saved in A");
		await expect(row(page, b1)).toBeVisible({ timeout: 20_000 });
		await page
			.locator(`#session-list [data-session-id="${b1}"] .session-item-title`)
			.click();
		await expectOpen(page, b1, "Saved in B");
		await page.goBack();
		await expectOpen(page, a1, "Saved in A");
		// The shell saves its rows once synchronized; wait until the device holds B's.
		await expect
			.poll(() =>
				page.evaluate(
					(id) =>
						new Promise<boolean>((resolve) => {
							const open = indexedDB.open("conduit-saved-shell");
							open.onerror = () => resolve(false);
							open.onsuccess = () => {
								const db = open.result;
								if (!db.objectStoreNames.contains("shell"))
									return resolve(false);
								const get = db
									.transaction("shell")
									.objectStore("shell")
									.get("daemon");
								get.onsuccess = () =>
									resolve(
										(get.result?.rows ?? []).some(
											(saved: { id: string }) => saved.id === id,
										),
									);
							};
						}),
					b1,
				),
			)
			.toBe(true);

		// No daemon reply: only the device's saved rows can draw the sidebar.
		await page.routeWebSocket(/\/rpc/, () => undefined);
		await page.reload();
		await expect(row(page, a1)).toBeVisible({ timeout: 20_000 });
		steps["savedRowsDrawn"] = {
			[a1]: await row(page, a1).count(),
			[b1]: await row(page, b1).count(),
		};
		await expect(row(page, b1)).toBeVisible({ timeout: 5_000 });
		steps["passed"] = true;
	} finally {
		evidence("saved-sidebar", steps);
	}
});

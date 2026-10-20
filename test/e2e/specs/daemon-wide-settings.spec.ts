import { writeFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";

import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

// Real daemon, isolated config and dynamic ports; only the provider SDK is fake.
const test = base.extend<{ harness: ProcessHarness }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await use(harness);
			} finally {
				writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
				await harness.dispose();
				harness.assertNoRunners();
			}
		},
		{ timeout: 120_000 },
	],
});

test.setTimeout(120_000);
test.use({ actionTimeout: 30_000 });

// Chromium can run without macOS child-process Mach ports in restricted shells.
if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

function observeRpc(page: Page) {
	const calls: Array<{
		tag: string;
		payload: Record<string, unknown>;
		exit?: { _tag: string; value?: unknown };
	}> = [];
	const sockets: Array<{ closed: boolean }> = [];
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const state = { closed: false };
		sockets.push(state);
		socket.on("close", () => {
			state.closed = true;
		});
		const pending = new Map<string, (typeof calls)[number]>();
		socket.on("framesent", (frame) => {
			const parsed: unknown = JSON.parse(String(frame.payload));
			const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
				_tag: string;
				id: string | number;
				tag: string;
				payload: Record<string, unknown>;
			}>;
			for (const message of messages) {
				if (message._tag !== "Request") continue;
				const call = { tag: message.tag, payload: message.payload };
				calls.push(call);
				pending.set(String(message.id), call);
			}
		});
		socket.on("framereceived", (frame) => {
			const parsed: unknown = JSON.parse(String(frame.payload));
			const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
				_tag: string;
				requestId: string | number;
				exit: { _tag: string; value?: unknown };
			}>;
			for (const message of messages) {
				if (message._tag !== "Exit") continue;
				const call = pending.get(String(message.requestId));
				if (call) call.exit = message.exit;
			}
		});
	});
	return { calls, sockets };
}

async function openInstances(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	await expect(page.locator("#instances-settings")).toBeVisible();
}

test("no project open: instance mutations, scan and log level use daemon RPC", async ({
	page,
	harness,
}, testInfo) => {
	// The startup probe registers a fixture project. Remove it so a cold browser
	// cannot auto-attach a default project.
	const projects = await harness.requestRpc({
		_tag: "RemoveProject",
		slug: "process-test",
	});
	expect(projects.projects).toEqual([]);
	const observed = observeRpc(page);
	await new AppPage(page).goto(harness.baseUrl);
	await expect
		.poll(
			() => observed.calls.find((call) => call.tag === "AttachProject")?.exit,
		)
		.toEqual({
			_tag: "Success",
			// No project, so no session to place either (8rdf.16).
			value: { projectSlug: null, sessionSlug: null },
		});
	// Record transient toasts too, even if they expire before the final assertion.
	await page.evaluate(() => {
		new MutationObserver((records) => {
			if (
				records.some((record) =>
					Array.from(record.addedNodes).some((node) =>
						node.textContent?.includes("No active project connection"),
					),
				)
			)
				document.documentElement.dataset["missingProjectToast"] = "true";
		}).observe(document.body, { childList: true, subtree: true });
	});
	await openInstances(page);
	await page.getByTestId("add-instance-btn").click();
	await page.getByTestId("instance-form-driver-opencode").click();
	await page.getByTestId("instance-form-name").fill("Settings E2E");
	await page.getByTestId("instance-form-managed").click();
	await page.getByTestId("instance-form-url").fill(harness.baseUrl);
	await page.getByTestId("instance-form-save").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	const addedRow = page.locator("[data-testid^='instance-row-']", {
		hasText: "Settings E2E",
	});
	await expect(addedRow).toBeVisible();
	const rowTestId = await addedRow.getAttribute("data-testid");
	if (rowTestId === null) throw new Error("Instance row has no test ID");
	const row = page.getByTestId(rowTestId);
	await row.getByRole("button").click();
	await row.getByTestId("edit-instance-btn").click();
	await page.getByTestId("instance-form-name").fill("Settings E2E edited");
	await page.getByTestId("instance-form-save").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	await expect(row).toContainText("Settings E2E edited");
	await row.getByRole("button").click();
	await row.getByTestId("remove-instance-btn").click();
	await page.getByTestId("confirm-modal-action").click();
	await expect(row).toHaveCount(0);
	await page.getByTestId("scan-now-btn").click();
	await expect
		.poll(
			() => observed.calls.find((call) => call.tag === "ScanNow")?.exit?._tag,
		)
		.toBe("Success");
	await expect(page.getByTestId("scan-now-btn")).toBeEnabled();
	await page.getByTestId("settings-close-btn").click();
	await page.keyboard.press("Control+Shift+D");
	await page.getByRole("button", { name: "verbose:off", exact: true }).click();
	await expect
		.poll(
			() =>
				observed.calls.find((call) => call.tag === "SetLogLevel")?.exit?._tag,
		)
		.toBe("Success");
	await expect(
		page.getByRole("button", { name: "verbose:on", exact: true }),
	).toBeVisible();
	const tags = [
		"DetectProxy",
		"AddInstance",
		"UpdateInstance",
		"RemoveInstance",
		"ScanNow",
		"SetLogLevel",
	];
	for (const tag of tags) {
		const call = observed.calls.find((call) => call.tag === tag);
		expect(call?.exit?._tag, tag).toBe("Success");
		expect(call?.payload, tag).not.toHaveProperty("projectSlug");
	}
	expect(
		await page.evaluate(
			() => document.documentElement.dataset["missingProjectToast"],
		),
	).toBeUndefined();
	await expect(
		page.getByText("No active project connection", { exact: true }),
	).toHaveCount(0);
	expect(observed.sockets).toEqual([{ closed: false }, { closed: false }]);
	writeFileSync(
		testInfo.outputPath("rpc.json"),
		JSON.stringify(observed, null, 2),
	);
});

test("open project: daemon settings retain the socket pair and a working session", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Settings connection");
	const observed = observeRpc(page);
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}`);
	await app.input.fill("settings connection still works");
	await openInstances(page);
	await page.getByTestId("scan-now-btn").click();
	await expect
		.poll(
			() => observed.calls.find((call) => call.tag === "ScanNow")?.exit?._tag,
		)
		.toBe("Success");
	await page.getByTestId("settings-close-btn").click();
	await expect(app.connectOverlay).toHaveCount(0);
	await expect(app.input).toHaveValue("settings connection still works");
	await app.sendMessage("settings connection still works");
	await expect(page.locator(".md-content").last()).toContainText("done(");
	await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`));
	expect(
		observed.calls.find((call) => call.tag === "ScanNow")?.payload,
	).not.toHaveProperty("projectSlug");
	expect(observed.sockets).toEqual([{ closed: false }, { closed: false }]);
	writeFileSync(
		testInfo.outputPath("rpc.json"),
		JSON.stringify(observed, null, 2),
	);
});

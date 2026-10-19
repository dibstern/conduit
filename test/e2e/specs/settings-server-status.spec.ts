import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Schema } from "effect";
import {
	type GetStatusResponse,
	GetStatusResponseSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { getVersion } from "../../../src/lib/version.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

// Real daemon and isolated config. The opt-in supervisor stands in for launchd.
const test = base.extend<{ harness: ProcessHarness; supervised: boolean }>({
	supervised: [true, { option: true }],
	harness: [
		async ({ supervised }, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				respawnOnExit: supervised,
			});
			try {
				await harness.restart({
					startupTimeoutMs: 60_000,
					serviceEnvironment: { CONDUIT_SERVICE: supervised ? "1" : "0" },
				});
				await harness.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
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

test.setTimeout(180_000);
test.use({ actionTimeout: 30_000 });

if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

function observeStatus(page: Page) {
	const reads: GetStatusResponse[] = [];
	const readSockets: number[] = [];
	const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
	let closedSockets = 0;
	let socketsCreated = 0;
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const socketId = ++socketsCreated;
		const requests = new Map<string, string>();
		socket.on("close", () => closedSockets++);
		socket.on("framesent", ({ payload }) => {
			const parsed: unknown = JSON.parse(String(payload));
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				if (!isRecord(message) || message["_tag"] !== "Request") continue;
				if (
					(typeof message["id"] !== "string" &&
						typeof message["id"] !== "number") ||
					typeof message["tag"] !== "string"
				)
					continue;
				requests.set(String(message["id"]), message["tag"]);
				if (isRecord(message["payload"]))
					calls.push({ tag: message["tag"], payload: message["payload"] });
			}
		});
		socket.on("framereceived", ({ payload }) => {
			const parsed: unknown = JSON.parse(String(payload));
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				if (
					!isRecord(message) ||
					message["_tag"] !== "Exit" ||
					(typeof message["requestId"] !== "string" &&
						typeof message["requestId"] !== "number")
				)
					continue;
				if (requests.get(String(message["requestId"])) !== "GetStatus")
					continue;
				const exit = message["exit"];
				if (isRecord(exit) && exit["_tag"] === "Success") {
					reads.push(
						Schema.decodeUnknownSync(GetStatusResponseSchema)(exit["value"]),
					);
					readSockets.push(socketId);
				}
			}
		});
	});
	return {
		reads,
		readSockets,
		calls,
		get socketsCreated() {
			return socketsCreated;
		},
		get closedSockets() {
			return closedSockets;
		},
	};
}

async function openServer(page: Page, baseUrl: string): Promise<void> {
	await new AppPage(page).goto(baseUrl);
	// Settings opens from whichever bar the landing view shows.
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	const sessionOverflow = page.getByTestId("session-bar-overflow");
	await expect(
		listOverflow.or(titleMenu).or(sessionOverflow).first(),
	).toBeVisible();
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await sessionOverflow.click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	await expect(page.getByTestId("server-status-card")).toBeVisible();
	await expect(page.getByTestId("server-status-version")).toHaveText(
		getVersion(),
	);
}

test("Server status reloads after two supervised restarts, with desktop and phone artifacts", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const observed = observeStatus(page);
	await openServer(page, harness.baseUrl);
	await expect(page.getByTestId("server-status-uptime")).toHaveText(/^up /);
	await expect(page.getByTestId("server-status-port")).toHaveText(
		`port ${new URL(harness.baseUrl).port}`,
	);
	await expect(page.getByTestId("server-status-browsers")).toHaveText(
		/\d+ browsers? connected/,
	);
	await expect.poll(() => observed.reads.length).toBeGreaterThan(0);
	expect(observed.reads.at(-1)?.supervised).toBe(true);
	expect(observed.reads.at(-1)?.clientCount).toBe(1);

	// All inline forms share one owner, including the instance editor.
	await page.getByTestId("add-instance-btn").click();
	await expect(page.getByTestId("instance-form-name")).toBeFocused();
	await page.getByTestId("server-shutdown-btn").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	await expect(page.getByTestId("server-shutdown-confirmation")).toContainText(
		"The login service will start it straight back.",
	);
	await expect(page.getByTestId("server-shutdown-cancel")).toBeFocused();
	await page.getByTestId("add-instance-btn").click();
	await expect(page.getByTestId("server-shutdown-confirmation")).toBeHidden();
	await expect(page.getByTestId("instance-form-name")).toBeFocused();
	await page.getByTestId("add-instance-btn").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	await page.getByTestId("server-shutdown-btn").click();
	await page.getByTestId("server-shutdown-btn").click();
	await expect(page.getByTestId("server-shutdown-confirmation")).toBeHidden();
	await page.getByTestId("server-shutdown-btn").click();
	await page.getByTestId("server-shutdown-cancel").click();
	await expect(page.getByTestId("server-shutdown-confirmation")).toBeHidden();
	expect(observed.calls.filter((call) => call.tag === "Shutdown")).toHaveLength(
		0,
	);

	for (let restart = 1; restart <= 2; restart++) {
		const previousPid = harness.generations.at(-1)?.pid;
		const readsBefore = observed.reads.length;
		const closedBefore = observed.closedSockets;
		const socketsBefore = observed.socketsCreated;
		await page.getByTestId("server-restart-btn").click();
		await expect
			.poll(() => observed.closedSockets, { timeout: 60_000 })
			.toBeGreaterThan(closedBefore);
		await expect
			.poll(() => harness.generations.length, { timeout: 60_000 })
			.toBe(restart + 1);
		expect(harness.generations.at(-1)?.pid).not.toBe(previousPid);
		expect(harness.generations.at(-1)?.port).toBe(
			Number(new URL(harness.baseUrl).port),
		);
		await expect
			.poll(() => observed.reads.length, { timeout: 60_000 })
			.toBeGreaterThan(readsBefore);
		// A successful read on a new socket proves the card reloaded from the
		// replacement daemon, rather than merely retaining its old snapshot.
		await expect
			.poll(() => observed.readSockets.at(-1) ?? 0, { timeout: 60_000 })
			.toBeGreaterThan(socketsBefore);
		await expect(new AppPage(page).connectOverlay).toHaveCount(0, {
			timeout: 60_000,
		});
		await expect(page.getByTestId("server-restart-btn")).toBeEnabled();
		await expect(page.getByTestId("server-status-version")).toHaveText(
			observed.reads.at(-1)?.version ?? "missing",
		);
		await expect(page.getByTestId("server-status-port")).toHaveText(
			`port ${harness.generations.at(-1)?.port}`,
		);
	}
	const restarts = observed.calls.filter(
		(call) => call.tag === "RestartWithConfig",
	);
	expect(restarts).toHaveLength(2);
	// Daemon-wide calls carry no project fields; the schema tag may ride along.
	for (const call of observed.calls.filter((call) =>
		["GetStatus", "RestartWithConfig"].includes(call.tag),
	))
		expect(Object.keys(call.payload).filter((key) => key !== "_tag")).toEqual(
			[],
		);

	const artifacts = resolve("test-results/settings-server-status");
	mkdirSync(artifacts, { recursive: true });
	const card = page.getByTestId("server-status-card");
	await card.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-desktop.png`),
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	// Both boxes from one frame: the settings sheet can still be moving, and two
	// separate reads can straddle the move.
	const [text, actions] = await page.evaluate(() =>
		["server-status-details", "server-status-actions"].map((id) => {
			const box = document
				.querySelector(`[data-testid="${id}"]`)
				?.getBoundingClientRect();
			return (
				box && { x: box.x, y: box.y, width: box.width, height: box.height }
			);
		}),
	);
	if (!text || !actions) throw new Error("Status card layout is missing");
	expect(actions.y).toBeGreaterThanOrEqual(text.y + text.height);
	expect(actions.x).toBeCloseTo(text.x, 0);
	expect(actions.width).toBeCloseTo(text.width, 0);
	await card.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-390px.png`),
		animations: "disabled",
	});
	writeFileSync(
		resolve(artifacts, `${testInfo.project.name}-rpc.json`),
		JSON.stringify(
			{
				calls: observed.calls,
				status: observed.reads,
				generations: harness.generations,
			},
			null,
			2,
		),
	);
});

test.describe("unsupervised daemon", () => {
	test.use({ supervised: false });
	test("hides Restart, explains terminal startup and closes the confirmation after Shut down", async ({
		page,
		harness,
	}) => {
		await openServer(page, harness.baseUrl);
		await expect(page.getByTestId("server-restart-btn")).toHaveCount(0);
		await expect(page.getByTestId("server-status-card")).toContainText(
			"conduit serve",
		);
		await page.getByTestId("server-shutdown-btn").click();
		await expect(page.getByTestId("server-shutdown-confirmation")).toHaveText(
			/Every browser disconnects\. Start it again from the terminal with conduit serve\./,
		);
		await page.getByTestId("server-shutdown-confirm").click();
		await expect(page.getByTestId("server-shutdown-confirmation")).toBeHidden();
		await expect(new AppPage(page).connectOverlay).toBeVisible();
		await harness.waitForExit();
	});
});

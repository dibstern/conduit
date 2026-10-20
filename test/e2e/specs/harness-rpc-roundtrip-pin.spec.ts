// Behaviour pin conduit-test-16c8.1: RPC failures, defects and cancellation
// round-trip between the real built daemon and a real browser page.
//
// Failure modes, and the assertion that catches each:
// - A typed failure is swallowed, replaced by a generic fallback, or leaks raw
//   transport text: the unknown-session banner and the inline mkdir rejection
//   must show their declared copy.
// - An unknown session resolves instead of failing: the harness ResolveSession
//   call must reject with the unknown-session message.
// - A typed rejection still writes to disk: the rejected folder must not exist.
// - A handler defect never answers, so the browser waits forever: the dialog's
//   fallback must render within the expect timeout, and the same RPC from the
//   harness must reject instead of hanging.
// - A defect tears down the socket or the daemon instead of failing one
//   request: no page WebSocket closes or opens, the daemon PID is unchanged,
//   and the page's next RPC on the same socket still answers.
// - The test-only defect leaks into ordinary runs: the typed SaveProject case
//   runs without CONDUIT_TEST_RPC_DEFECT and must reach the typed rejection.
// - Composer Stop only clears client state: the fake SDK must record the
//   query's interrupt and close.
// - Closing a draft's model subscription leaves its borrowed OpenCode running:
//   the managed instance must report stopped and its process must exit.
// The artifact records each case's outcome and latency. Latency is evidence,
// never a threshold; bounded waits only turn hangs into failures.
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo, WebSocket } from "@playwright/test";
import { Effect } from "effect";
import { isProcessAlive } from "../../../src/lib/instance/managed-opencode-process.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const observed = new Map<string, { case: string; [key: string]: unknown }>();

// Every attempt starts a fresh record, so failures and retries are reported too.
function begin(testInfo: TestInfo, caseId: string) {
	observed.set(testInfo.testId, { case: caseId });
}

function observe(testInfo: TestInfo, evidence: Record<string, unknown>) {
	const entry = observed.get(testInfo.testId);
	if (!entry) throw new Error("observe() before begin()");
	observed.set(testInfo.testId, { ...entry, ...evidence });
}

const since = (start: number) => Math.round(performance.now() - start);

test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
	const entry = observed.get(testInfo.testId);
	if (!entry) return;
	const artifact = testInfo.outputPath("rpc-roundtrip.json");
	writeFileSync(
		artifact,
		`${JSON.stringify({ project: testInfo.project.name, outcome: testInfo.status, ...entry }, null, 2)}\n`,
	);
	await testInfo.attach("rpc-roundtrip", {
		path: artifact,
		contentType: "application/json",
	});
});

async function openProjectDialog(page: Page, harness: ProcessHarness) {
	await new AppPage(page).goto(harness.baseUrl);
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function chooseExistingFolder(dialog: Locator, path: string) {
	await dialog.getByRole("combobox", { name: "Add folder" }).fill(path);
	await dialog.getByRole("option", { name: path, exact: true }).click();
}

test.describe("typed failures", () => {
	test("an unknown session ID shows the session-not-found banner", async ({
		page,
		harness,
	}, testInfo) => {
		begin(testInfo, "typed-unknown-session");
		const sessionId = "ses_16c8_1_missing";
		const started = performance.now();
		await new AppPage(page).goto(`${harness.baseUrl}/s/${sessionId}`);
		const banner = page.getByText(
			"Session not found. That session no longer exists.",
		);
		await expect(banner).toBeVisible();
		const latencyMs = since(started);
		await expect(page).toHaveURL(`${harness.baseUrl}/`);
		const browser = await harness.connect();
		const rejection = await Effect.runPromise(
			browser.rpc.ResolveSession({ sessionId }),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(rejection).toHaveProperty(
			"message",
			expect.stringContaining(`Unknown session: ${sessionId}`),
		);
		observe(testInfo, {
			latencyMs,
			rendered: await banner.innerText(),
			finalPath: new URL(page.url()).pathname,
		});
	});

	test("a new folder under a missing parent shows the inline mkdir rejection", async ({
		page,
		harness,
	}, testInfo) => {
		begin(testInfo, "typed-project-save-rejected");
		const missingParent = join(
			realpathSync(harness.root),
			"missing-parent",
			"notes",
		);
		const dialog = await openProjectDialog(page, harness);
		await dialog
			.getByRole("combobox", { name: "Add folder" })
			.fill(missingParent);
		await dialog.getByRole("option", { name: /New folder/ }).click();
		const started = performance.now();
		await dialog.getByRole("button", { name: /^Add project/ }).click();
		const alert = dialog.getByRole("alert");
		await expect(alert).toContainText(`Couldn't create ${missingParent}: `);
		const latencyMs = since(started);
		await expect(alert).not.toContainText("Couldn't save the project");
		await expect(dialog).toBeVisible();
		expect(existsSync(missingParent)).toBe(false);
		observe(testInfo, {
			latencyMs,
			// The OS error text after the path varies by platform.
			renderedPrefix: (await alert.innerText()).startsWith(
				`Couldn't create ${missingParent}: `,
			),
		});
	});
});

test.describe("defect", () => {
	test.use({ startHarness: false });

	test("a SaveProject defect fails the request without dropping the socket", async ({
		page,
		harness,
	}, testInfo) => {
		begin(testInfo, "defect-save-project");
		await harness.restart({
			serviceEnvironment: { CONDUIT_TEST_RPC_DEFECT: "SaveProject" },
		});
		const daemonPid = harness.generations.at(-1)?.pid;
		expect(daemonPid).toBeGreaterThan(0);
		const sockets: WebSocket[] = [];
		page.on("websocket", (socket) => sockets.push(socket));
		const folder = mkdtempSync(join(realpathSync(harness.root), "defect-"));
		const dialog = await openProjectDialog(page, harness);
		await chooseExistingFolder(dialog, folder);
		const socketsBefore = sockets.filter((socket) => !socket.isClosed());
		expect(socketsBefore.length).toBeGreaterThan(0);
		const started = performance.now();
		await dialog.getByRole("button", { name: /^Add project/ }).click();
		const alert = dialog.getByRole("alert");
		await expect(alert).toContainText("Couldn't save the project. Try again.");
		const latencyMs = since(started);
		const rendered = await alert.innerText();
		await expect(dialog).toBeVisible();
		// The same page socket still answers its next request.
		const other = mkdtempSync(join(realpathSync(harness.root), "after-"));
		await chooseExistingFolder(dialog, other);
		await expect(dialog.getByTestId("project-folder-row")).toHaveCount(2);
		expect(sockets).toEqual(socketsBefore);
		expect(sockets.some((socket) => socket.isClosed())).toBe(false);
		expect(harness.generations.at(-1)?.pid).toBe(daemonPid);
		expect(isProcessAlive(daemonPid ?? 0)).toBe(true);
		const browser = await harness.connect();
		const harnessStarted = performance.now();
		const harnessRejected = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [folder] }),
		).then(
			() => false,
			() => true,
		);
		const harnessLatencyMs = since(harnessStarted);
		expect(harnessRejected).toBe(true);
		const { projects } = await Effect.runPromise(browser.rpc.GetProjects({}));
		expect(projects.flatMap((project) => project.folders)).not.toContain(
			folder,
		);
		observe(testInfo, {
			latencyMs,
			harnessLatencyMs,
			rendered,
			socketsOpened: sockets.length,
			socketsClosed: sockets.filter((socket) => socket.isClosed()).length,
			daemonRestarted: harness.generations.at(-1)?.pid !== daemonPid,
		});
	});
});

type ProofMark = Record<string, unknown>;

function marks(harness: ProcessHarness): ProofMark[] {
	const file = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Invalid SDK proof");
			return Object.fromEntries(Object.entries(value));
		});
}

test.describe("cancel a running turn", () => {
	test.use({ harnessOptions: { restartProof: true } });

	test("composer Stop interrupts and closes the provider query", async ({
		page,
		harness,
	}, testInfo) => {
		begin(testInfo, "cancel-composer-stop");
		const browser = await harness.connect();
		const sessionId = await browser.createSession("RPC round-trip Stop");
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(`${harness.baseUrl}/s/${sessionId}`);
		await app.sendMessage("task-stop-foreground-no-tasks");
		const streaming = () =>
			marks(harness).find(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
			);
		// Spawning the provider runner is slow on a loaded machine.
		await expect.poll(streaming, { timeout: 30_000 }).toBeDefined();
		const queryId = streaming()?.["queryId"];
		if (typeof queryId !== "string") throw new Error("Missing held query");
		const queryMarks = (kind: string) =>
			marks(harness).filter(
				(mark) => mark["queryId"] === queryId && mark["kind"] === kind,
			).length;
		expect(queryMarks("query-closed")).toBe(0);
		await expect(chat.stopBtn).toBeVisible();
		const started = performance.now();
		await chat.stopBtn.click();
		await expect.poll(() => queryMarks("query-closed")).toBe(1);
		const latencyMs = since(started);
		expect(queryMarks("query-interrupted")).toBe(1);
		await expect(chat.stopBtn).toBeHidden();
		observe(testInfo, {
			latencyMs,
			queryInterrupted: queryMarks("query-interrupted"),
			queryClosed: queryMarks("query-closed"),
		});
	});
});

test.describe("close a stream subscription", () => {
	const instanceId = "opencode";
	const sonnet: ModelInfo = {
		id: "sonnet",
		name: "Sonnet",
		providerId: "claude",
		variants: { low: {} },
		contextWindowOptions: [{ value: "200k", label: "200k", isDefault: true }],
	};
	test.setTimeout(120_000);
	test.use({
		harnessOptions: {
			managedOpenCode: true,
			managedOpenCodeId: instanceId,
			// Test-only borrow grace; production keeps its own.
			opencodeBorrowIdleTimeoutMs: 1_000,
			capabilityModels: [sonnet],
		},
	});

	async function instance(browser: ProcessBrowser) {
		return (await browser.instances()).instances.find(
			(entry) => entry.id === instanceId,
		);
	}

	async function selectHarness(page: Page, picker: Locator, driver: string) {
		await openPickerRoot(page, picker);
		await page.getByTestId(`picker-harness-${driver}`).click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();
		await expect(picker).toHaveAttribute("data-instance-id", driver);
	}

	test("leaving OpenCode in a draft closes its model subscription and stops the borrowed instance", async ({
		page,
		harness,
	}, testInfo) => {
		begin(testInfo, "cancel-draft-model-subscription");
		const directory = mkdtempSync(join(harness.root, "subscription-project-"));
		const browser = await harness.connect();
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory] }),
		);
		if (!slug) throw new Error("SaveProject did not return a slug");
		await Effect.runPromise(
			browser.rpc.SetDefaultModel({
				projectSlug: slug,
				provider: "claude",
				model: "sonnet",
			}),
		);
		for (const harnessId of ["claude", "opencode"] as const)
			await Effect.runPromise(
				browser.rpc.SetHarnessDefault({
					projectSlug: slug,
					harness: harnessId,
					providerId: harnessId === "claude" ? "claude" : "fake",
					modelId: harnessId === "claude" ? "sonnet" : "fake-model",
					effort: harnessId === "claude" ? "low" : "",
					contextWindow: harnessId === "claude" ? "200k" : "",
				}),
			);
		// Fixture setup may start OpenCode; the draft must begin with it stopped.
		await browser.stopInstance(instanceId);
		expect((await instance(browser))?.status).toBe("stopped");
		await new AppPage(page).goto(
			`${harness.baseUrl}/new?p=${encodeURIComponent(slug)}`,
		);
		const picker = page.locator(
			'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
		);
		await expect(picker).toHaveAttribute("data-shown-harness", "claude");
		// Only the draft's OpenCode model subscription starts the instance.
		await selectHarness(page, picker, "opencode");
		await expect
			.poll(async () => (await instance(browser))?.status, { timeout: 20_000 })
			.toBe("healthy");
		const pid = (await instance(browser))?.pid ?? 0;
		expect(isProcessAlive(pid)).toBe(true);
		const started = performance.now();
		await selectHarness(page, picker, "claude");
		await expect
			.poll(async () => (await instance(browser))?.status, { timeout: 20_000 })
			.toBe("stopped");
		await expect.poll(() => isProcessAlive(pid)).toBe(false);
		const latencyMs = since(started);
		const { sessions } = await Effect.runPromise(
			browser.rpc.ListDaemonSessions({ projectSlug: slug }),
		);
		expect(sessions).toEqual([]);
		observe(testInfo, {
			latencyMs,
			borrowIdleTimeoutMs: 1_000,
			finalStatus: (await instance(browser))?.status,
			processExited: !isProcessAlive(pid),
		});
	});
});

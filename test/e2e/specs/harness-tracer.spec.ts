import { mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

// chat-simple's first prompt and reply; pong-thinking-text-turn has the same reply.
const prompt = "Hello, reply with just the word pong";
const reply = "pong";

async function sendFromAddedProject(
	page: Page,
	harness: ProcessHarness,
	driver: "opencode" | "claude",
): Promise<{ directory: string; slug: string }> {
	const directory = mkdtempSync(join(harness.root, "browser-project-"));
	const browser = await harness.connect();
	const added = await Effect.runPromise(
		browser.rpc.SaveProject({ folders: [directory] }),
	);
	const slug = added.savedSlug;
	if (!slug)
		throw new Error("SaveProject did not return the new project's slug");
	expect(slug).not.toBe("process-test");
	expect(added.projects).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ folders: [directory], slug }),
		]),
	);

	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const sidebar = new SidebarPage(page);
	await app.goto(`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`);
	await page.locator("#new-session-btn:visible").click();
	await app.chooseDraftProject(basename(directory));
	expect(new URL(page.url()).searchParams.get("project")).toBe(slug);
	await expect(app.input).toBeVisible();
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
	);
	await openPickerRoot(page, picker);
	if ((await picker.getAttribute("data-instance-id")) !== driver)
		await page.getByTestId(`picker-harness-${driver}`).click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator("[data-model-id]")
		.first()
		.click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
	await expect(picker).toHaveAttribute("data-instance-id", driver);
	// New session opens a draft. Its first send creates the bound session.
	await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
	expect(
		(
			await Effect.runPromise(
				browser.rpc.ListDaemonSessions({ projectSlug: slug }),
			)
		).sessions,
	).toHaveLength(0);
	const countBefore = await sidebar.getSessionCount();
	await app.input.fill(prompt);
	await expect(app.sendBtn).toBeEnabled();
	await app.sendBtn.click();
	await expect(page).toHaveURL(/\/s\/[^/?]+(?:\?.*)?$/);
	await expect
		.poll(() => sidebar.getSessionCount())
		.toBeGreaterThan(countBefore);
	await expect(chat.userMessages.last()).toContainText(prompt);
	const assistant = chat.assistantMessages.last().locator(".md-content");
	await expect(assistant).toBeVisible();
	await expect(assistant).toHaveText(reply);
	await chat.waitForStreamingComplete();
	return { directory, slug };
}

test.describe("OpenCode", () => {
	test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

	test("replays a recorded turn through the built server", async ({
		page,
		harness,
	}, testInfo) => {
		await sendFromAddedProject(page, harness, "opencode");
		await page.screenshot({ path: testInfo.outputPath("opencode-tracer.png") });
	});
});

test.describe("Claude", () => {
	test.use({
		harnessOptions: { claudeReplay: { turns: ["pong-thinking-text-turn"] } },
	});

	test("first draft send creates one session, opens it, and replays a Claude runner turn", async ({
		page,
		harness,
	}, testInfo) => {
		const { directory, slug } = await sendFromAddedProject(
			page,
			harness,
			"claude",
		);
		const sessionId = new URL(page.url()).pathname.match(/\/s\/([^/]+)/)?.[1];
		expect(sessionId).toBeTruthy();
		const browser = await harness.connect();
		const { sessions } = await Effect.runPromise(
			browser.rpc.ListDaemonSessions({ projectSlug: slug }),
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(sessionId);
		const options = harness.claudeOptions();
		expect(options).not.toHaveLength(0);
		const runnerOptions = options.filter(({ pid }) =>
			harness.runnerPids().includes(pid),
		);
		expect(runnerOptions).not.toHaveLength(0);
		for (const record of runnerOptions) {
			expect(harness.runnerPids()).toContain(record.pid);
			expect(record.pid).not.toBe(harness.generations.at(-1)?.pid);
			expect(record.options["cwd"]).toBe(directory);
			// The agent's tools inherit this env, so a session can name itself.
			expect(record.options["env"]).toMatchObject({
				CONDUIT_SESSION_ID: sessionId,
			});
		}
		await page.screenshot({ path: testInfo.outputPath("claude-tracer.png") });
	});
});

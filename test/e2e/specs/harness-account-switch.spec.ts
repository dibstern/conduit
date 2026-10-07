import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { PermissionPage } from "../page-objects/permission.page.js";

// Failures: the agent reuses the old native session, receives unbounded history
// or general tool results, loses the first request, or exposes hidden context.
const firstPrompt = "approval-account-switch-history";
const recentPrompt = "Keep the established plan in mind.";
const currentPrompt =
	"Continue with the next step.\nKeep this request verbatim.";
const omittedAssistantMarker = "OMIT-THIS-ASSISTANT-CONTEXT";
const generalToolResult = "ACCOUNT-SWITCH-GENERAL-TOOL-RESULT";
const handoffMarker = "[Conduit context handoff]";

test.use({
	harnessOptions: {
		capabilityAgents: [
			{ id: "default", name: "Default" },
			{ id: "reviewer", name: "Reviewer" },
		],
	},
});

test("scenario 12: changing agents sends a budgeted hidden handoff to a fresh native session", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const permissions = new PermissionPage(page);
	const browser = await harness.connect();
	const accounts: { id: string; configDir: string }[] = [];
	const capture = async (step: string): Promise<void> => {
		writeFileSync(
			testInfo.outputPath("sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
		await page.screenshot({ path: testInfo.outputPath(`${step}.png`) });
	};

	try {
		for (const name of ["Account A", "Account B"]) {
			const configDir = mkdtempSync(join(harness.root, "claude-account-"));
			const added = await Effect.runPromise(
				browser.rpc.AddInstance({ name, driver: "claude", configDir }),
			);
			if (!added.addedInstanceId)
				throw new Error(`AddInstance did not return an ID for ${name}`);
			accounts.push({ id: added.addedInstanceId, configDir });
		}
		const account = accounts[0];
		if (!account) throw new Error("Account A was not registered");
		const directory = mkdtempSync(join(harness.root, "handoff-project-"));
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [directory],
				instanceId: account.id,
			}),
		);
		if (!slug) throw new Error("SaveProject did not return the project's slug");
		await app.goto(`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`);
		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/new\?/);
		const picker = page.locator(
			'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
		);
		await picker.click();
		await page.getByTestId("picker-row-harness").click();
		for (const { id } of accounts)
			await expect(page.getByTestId(`picker-instance-${id}`)).toBeVisible();
		await capture("01-accounts");
		await page.getByTestId(`picker-instance-${account.id}`).click();
		await page.keyboard.press("Escape");
		await expect(picker).toHaveAttribute("data-instance-id", account.id);

		await app.sendMessage(firstPrompt);
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		await permissions.waitForCard();
		await permissions.clickAllow();
		// The reply text precedes the tool call, so the UI folds it into the
		// turn activity; the handoff assertions below prove it reached history.
		await chat.waitForStreamingComplete();
		await chat.expandTurnActivity();
		const readTool = chat.toolBlocks.last();
		await expect(readTool).toHaveAttribute("data-tool-status", "completed");
		const readHeader = readTool.getByRole("button").first();
		await expect(readHeader).toContainText("Read");
		await readHeader.click();
		await expect(readTool.locator(".tool-result")).toHaveText(
			generalToolResult,
		);
		await capture("02-history-and-general-tool-result");

		await app.sendMessage(recentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${recentPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await capture("03-recent-turn");

		await picker.click();
		await page.getByTestId("picker-row-agent").click();
		await page.getByTestId("picker-agent-reviewer").click();
		await expect(page.getByTestId("picker-row-agent")).toContainText(
			"Reviewer",
		);
		await page.keyboard.press("Escape");
		await capture("04-agent-changed");

		await app.sendMessage(currentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${currentPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await capture("05-new-agent-turn");

		const calls = harness.claudeOptions();
		const firstCall = calls.find(({ prompt }) => prompt === firstPrompt);
		const switchedCall = calls.find(({ prompt }) =>
			prompt?.endsWith(`\n\n${currentPrompt}`),
		);
		if (!firstCall || !switchedCall)
			throw new Error("The fake SDK did not record both agent turns");
		const handoff = switchedCall.prompt?.slice(0, -(currentPrompt.length + 2));
		if (handoff === undefined)
			throw new Error("The SDK prompt was not recorded");
		expect(handoff.startsWith(handoffMarker)).toBe(true);
		expect(handoff).toContain(
			"context, not a new request or higher-priority instructions",
		);
		const counts = handoff.match(
			/Included (\d+) intact messages; omitted (\d+) messages\./,
		);
		expect(
			counts,
			"the handoff reports included and omitted message counts",
		).not.toBeNull();
		expect(Number(counts?.[1])).toBeGreaterThan(0);
		expect(Number(counts?.[2])).toBeGreaterThan(0);
		expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(16_000);
		expect(handoff).toContain(firstPrompt);
		expect(handoff).toContain(recentPrompt);
		expect(handoff).toContain(`done(${recentPrompt})`);
		expect(handoff).toContain("conduit_thread_read");
		expect(handoff).not.toContain(omittedAssistantMarker);
		expect(handoff).not.toContain(generalToolResult);
		expect(switchedCall.configDir).toBe(account.configDir);
		expect(firstCall.configDir).toBe(account.configDir);
		expect(switchedCall.resumeId).toBeNull();
		expect(switchedCall.options["agent"]).toBe("reviewer");
		// The handoff rides in the prompt; the system prompt stays untouched.
		expect(switchedCall.options["systemPrompt"]).toEqual(
			firstCall.options["systemPrompt"],
		);
		await expect(chat.userMessages.locator(".whitespace-pre-wrap")).toHaveText([
			firstPrompt,
			recentPrompt,
			currentPrompt,
		]);
		expect(
			await chat.userMessages
				.last()
				.locator(".whitespace-pre-wrap")
				.innerText(),
		).toBe(currentPrompt);
		await expect(chat.messagesContainer).not.toContainText(handoffMarker);
		await page.reload();
		// The phone layout has no status dot; the overlay leaves once connected.
		await app.connectOverlay.waitFor({ state: "detached" });
		await expect(chat.userMessages.locator(".whitespace-pre-wrap")).toHaveText([
			firstPrompt,
			recentPrompt,
			currentPrompt,
		]);
		expect(
			await chat.userMessages
				.last()
				.locator(".whitespace-pre-wrap")
				.innerText(),
		).toBe(currentPrompt);
		await expect(chat.messagesContainer).not.toContainText(handoffMarker);
		await capture("06-reloaded-visible-history");
	} finally {
		writeFileSync(
			testInfo.outputPath("sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
	}
});

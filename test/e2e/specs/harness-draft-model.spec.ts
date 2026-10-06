import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

// chat-simple's first prompt and reply. The mock replays that reply whatever
// model is sent, so the assertions read what conduit actually sent to OpenCode.
const prompt = "Hello, reply with just the word pong";
const picked = { providerID: "opencode", modelID: "nemotron-3-super-free" };

const jsonModel = (body: string): unknown =>
	(JSON.parse(body) as { model?: unknown }).model ?? null;

// OpenCode has no "claude" provider: sending one fails with "Model not found".
const isClaudeModel = (model: unknown): boolean =>
	(model as { providerID?: unknown } | null)?.providerID === "claude";

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

/** A project whose relay default is a Claude-harness model, as the reporter's
 *  was, opened on a new-session draft. `prepare` runs before the page loads.
 *  Returns the composer's model picker. */
async function openDraft(
	page: Page,
	harness: ProcessHarness,
	prepare?: (browser: ProcessBrowser, projectSlug: string) => Promise<void>,
): Promise<Locator> {
	const directory = mkdtempSync(join(harness.root, "browser-project-"));
	const browser = await harness.connect();
	const { savedSlug: slug } = await Effect.runPromise(
		browser.rpc.SaveProject({ folders: [directory] }),
	);
	if (!slug)
		throw new Error("SaveProject did not return the new project's slug");
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus[1m]",
			provider: "claude",
		}),
	);
	await prepare?.(browser, slug);
	await new AppPage(page).goto(
		`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`,
	);
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/new\?/);
	return page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
	);
}

/** Send the draft's first message (which creates the session), then record
 *  what reached OpenCode as a JSON artifact plus a screenshot. */
async function sendAndCapture(
	page: Page,
	harness: ProcessHarness,
	picker: Locator,
	testInfo: TestInfo,
) {
	const chat = new ChatPage(page);
	await new AppPage(page).sendMessage(prompt);
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect(chat.assistantMessages.last().locator(".md-content")).toHaveText(
		"pong",
	);
	await chat.waitForStreamingComplete();

	const requests = harness.opencodeRequestBodies();
	const evidence = {
		promptModels: requests
			.filter(
				({ method, path }) =>
					method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path),
			)
			.map(({ body }) => jsonModel(body)),
		configModels: requests
			.filter(({ method, path }) => method === "PATCH" && path === "/config")
			.map(({ body }) => jsonModel(body)),
		instanceAfterSend: await picker.getAttribute("data-instance-id"),
	};
	writeFileSync(
		testInfo.outputPath("draft-model-evidence.json"),
		JSON.stringify(evidence, null, 2),
	);
	await page.screenshot({ path: testInfo.outputPath("draft-model.png") });
	expect
		.soft(
			evidence.configModels.filter(
				(model) => typeof model === "string" && model.startsWith("claude/"),
			),
			"OpenCode config never receives a Claude-harness model",
		)
		.toEqual([]);
	return evidence;
}

test("a model picked in the draft composer is the model OpenCode runs", async ({
	page,
	harness,
}, testInfo) => {
	const picker = await openDraft(page, harness);
	await picker.click();
	await page.getByTestId("picker-row-harness").click();
	await page.getByTestId("picker-instance-opencode").click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator(
			`[data-model-id="${picked.modelID}"][data-provider-id="${picked.providerID}"]`,
		)
		.click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect
		.soft(evidence.promptModels, "prompt_async carries the drafted model")
		.toEqual([picked]);
	expect
		.soft(evidence.instanceAfterSend, "the composer stays on OpenCode")
		.toBe("opencode");
});

test("a draft harness restored from an earlier visit never sends OpenCode a Claude model", async ({
	page,
	harness,
}, testInfo) => {
	// The harness pick persists across visits; the model pick does not.
	await page.addInitScript(() =>
		localStorage.setItem("conduit-selected-instance", "opencode"),
	);
	const picker = await openDraft(page, harness);
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect
		.soft(
			evidence.promptModels.filter(isClaudeModel),
			"prompt_async never carries a Claude-harness model",
		)
		.toEqual([]);
});

test("a model picked on another harness never reaches an OpenCode that lists no models", async ({
	page,
	harness,
}, testInfo) => {
	// Hiding every OpenCode model leaves OpenCode running with an empty list,
	// as one still loading its catalogue would be.
	const picker = await openDraft(
		page,
		harness,
		async (browser, projectSlug) => {
			const { providers } = await Effect.runPromise(
				browser.rpc.GetModels({ projectSlug }),
			);
			await Effect.runPromise(
				browser.rpc.SetHiddenEntries({
					projectSlug,
					hiddenModels: providers
						.filter((provider) => provider.id !== "claude")
						.flatMap((provider) =>
							provider.models.map((model) => `${provider.id}/${model.id}`),
						),
				}),
			);
		},
	);
	await picker.click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator('[data-provider-id="claude"]')
		.first()
		.click();
	await page.getByTestId("picker-row-harness").click();
	await page.getByTestId("picker-instance-opencode").click();
	await page.keyboard.press("Escape");
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect
		.soft(
			evidence.promptModels.filter(isClaudeModel),
			"prompt_async never carries the other harness's pick",
		)
		.toEqual([]);
});

test.describe("effort", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: [
				{
					id: "opus",
					name: "Opus",
					providerId: "claude",
					variants: { high: {}, max: {} },
				},
				{
					id: "sonnet",
					name: "Sonnet",
					providerId: "claude",
					variants: { low: {}, high: {} },
				},
			],
		},
	});

	/** Earlier sessions saved an effort per model: Sonnet low, Opus max. Opus
	 *  is then made the default, so max is also the default effort. */
	async function saveEfforts(browser: ProcessBrowser, projectSlug: string) {
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({ projectSlug, originId: "effort-setup" }),
		);
		for (const [modelId, variant] of [
			["sonnet", "low"],
			["opus", "max"],
		] as const) {
			await Effect.runPromise(
				browser.rpc.SwitchModel({
					projectSlug,
					sessionId,
					modelId,
					providerId: "claude",
				}),
			);
			await Effect.runPromise(
				browser.rpc.SwitchVariant({ projectSlug, sessionId, variant }),
			);
		}
		await Effect.runPromise(
			browser.rpc.SetDefaultModel({
				projectSlug,
				model: "opus",
				provider: "claude",
			}),
		);
	}

	/** Send the draft's first message and return the model and effort that turn
	 *  ran with, recorded as a JSON artifact plus before and after screenshots. */
	async function sendAndReadFirstTurn(
		page: Page,
		harness: ProcessHarness,
		testInfo: TestInfo,
	) {
		await page.screenshot({
			path: testInfo.outputPath("draft-effort-before-send.png"),
		});
		const effortPrompt = "Which effort is this?";
		const chat = new ChatPage(page);
		await new AppPage(page).sendMessage(effortPrompt);
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		// The fake Claude's reply ends with done(<prompt>) once the turn has run.
		// Waiting on the stop button alone passes before the turn even starts.
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${effortPrompt})`,
		);
		await chat.waitForStreamingComplete();

		const firstTurn = harness.marks.flatMap((mark) =>
			mark.kind === "enqueue" && mark.prompt === effortPrompt
				? [
						{
							model: mark.liveOptions.model ?? null,
							effort: mark.liveOptions.effort ?? null,
						},
					]
				: [],
		);
		writeFileSync(
			testInfo.outputPath("draft-effort-evidence.json"),
			JSON.stringify({ firstTurn }, null, 2),
		);
		await page.screenshot({ path: testInfo.outputPath("draft-effort.png") });
		return firstTurn;
	}

	test("a model picked in the draft runs at its own saved effort, not the default model's", async ({
		page,
		harness,
	}, testInfo) => {
		const picker = await openDraft(page, harness, saveEfforts);
		await picker.click();
		await page.getByTestId("picker-row-model").click();
		await page
			.getByTestId("model-picker-list")
			.locator('[data-model-id="sonnet"][data-provider-id="claude"]')
			.click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();

		expect(
			await sendAndReadFirstTurn(page, harness, testInfo),
			"the first turn runs Sonnet at Sonnet's saved effort",
		).toEqual([{ model: "sonnet", effort: "low" }]);
	});

	test("an effort picked in the draft is the effort the first turn runs", async ({
		page,
		harness,
	}, testInfo) => {
		const picker = await openDraft(page, harness, saveEfforts);
		await picker.click();
		await page.getByTestId("picker-effort-option-high").click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();

		expect(
			await sendAndReadFirstTurn(page, harness, testInfo),
			"the first turn runs the default model at the picked effort",
		).toEqual([{ model: "opus", effort: "high" }]);
	});
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
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
// A 1x1 PNG.
const pixel =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const jsonModel = (body: string): unknown =>
	(JSON.parse(body) as { model?: unknown }).model ?? null;

// OpenCode has no "claude" provider: sending one fails with "Model not found".
const isClaudeModel = (model: unknown): boolean =>
	(model as { providerID?: unknown } | null)?.providerID === "claude";

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

/** A project whose relay default is a Claude-harness model, as the reporter's
 *  was, opened on a new-session draft with OpenCode running. `prepare` runs
 *  before the page loads. Returns the composer's model picker. */
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
	// The reporter's OpenCode was running. Model discovery never starts a
	// stopped one, so a draft would list none of its models.
	await browser.startInstance("opencode");
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
	const prompts = requests
		.filter(
			({ method, path }) =>
				method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path),
		)
		.map(
			({ body }) =>
				JSON.parse(body) as {
					model?: unknown;
					variant?: unknown;
					parts?: readonly { type?: unknown }[];
				},
		);
	const evidence = {
		promptModels: prompts.map(({ model }) => model ?? null),
		promptVariants: prompts.map(({ variant }) => variant ?? null),
		promptFiles: prompts.flatMap(
			({ parts }) => parts?.filter(({ type }) => type === "file") ?? [],
		),
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

/** Pick the OpenCode harness, then `picked`, in the draft composer. */
async function pickOpenCodeModel(page: Page, picker: Locator) {
	await picker.click();
	await page.getByTestId("picker-harness-opencode").click();
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
}

/** An RPC frame on the page's socket. Requests carry `tag` and `payload`;
 *  replies name their request with `requestId`. */
type RpcFrame = {
	readonly _tag?: string;
	readonly id?: string;
	readonly tag?: string;
	readonly requestId?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
};

/** Pass the page's RPC frames through `edit`, which sees each with the request
 *  it answers and resolves to the frame to deliver, or null to drop it. A frame
 *  held by a pending edit holds back no other frame. */
async function editRpc(
	page: Page,
	edit: (frame: RpcFrame, request: RpcFrame | undefined) => unknown,
): Promise<void> {
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		const requests = new Map<string, RpcFrame>();
		const relay =
			(send: (message: string | Buffer) => void) =>
			async (message: string | Buffer) => {
				if (typeof message !== "string") return send(message);
				const frame = JSON.parse(message) as RpcFrame;
				if (frame._tag === "Request" && frame.id) requests.set(frame.id, frame);
				const edited = await edit(
					frame,
					frame.requestId ? requests.get(frame.requestId) : undefined,
				);
				if (edited !== null) send(JSON.stringify(edited));
			};
		ws.onMessage(relay((message) => server.send(message)));
		server.onMessage(relay((message) => ws.send(message)));
	});
}

/** `value` with every model catalogue in it emptied. */
const withoutCatalogues = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(withoutCatalogues)
		: typeof value === "object" && value !== null
			? Object.fromEntries(
					Object.entries(value).map(([key, entry]) => [
						key,
						key === "providers" ? [] : withoutCatalogues(entry),
					]),
				)
			: value;

/** Open an OpenCode session that picked `picked`. Returns its model picker. */
async function openPickedSession(
	page: Page,
	harness: ProcessHarness,
): Promise<Locator> {
	let url = "";
	const picker = await openDraft(
		page,
		harness,
		async (browser, projectSlug) => {
			const { sessionId } = await Effect.runPromise(
				browser.rpc.CreateSession({
					projectSlug,
					originId: "session-setup",
					instanceId: ProviderInstanceIdSchema.make("opencode"),
					model: { modelId: picked.modelID, providerId: picked.providerID },
				}),
			);
			url = `${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`;
		},
	);
	await new AppPage(page).goto(url);
	await expect(picker).toHaveAccessibleName(/nemotron/i);
	return picker;
}

/** Settings lives in the list overflow or session title sheet on a phone,
 *  and in the session bar overflow on desktop. */
async function openSettingsPanel(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
		return;
	}
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
		return;
	}
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
}

test("a model picked in the draft composer is the model OpenCode runs", async ({
	page,
	harness,
}, testInfo) => {
	const picker = await openDraft(page, harness);
	await pickOpenCodeModel(page, picker);

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect
		.soft(evidence.promptModels, "prompt_async carries the drafted model")
		.toEqual([picked]);
	expect
		.soft(evidence.instanceAfterSend, "the composer stays on OpenCode")
		.toBe("opencode");
});

test("an OpenCode model runs at the effort conduit shows for it", async ({
	page,
	harness,
}, testInfo) => {
	let setup: { browser: ProcessBrowser; projectSlug: string } | undefined;
	const picker = await openDraft(
		page,
		harness,
		async (browser, projectSlug) => {
			// An earlier session saved high for the model the draft picks.
			setup = { browser, projectSlug };
			const { sessionId } = await Effect.runPromise(
				browser.rpc.CreateSession({
					projectSlug,
					originId: "effort-setup",
					instanceId: ProviderInstanceIdSchema.make("opencode"),
					model: { modelId: picked.modelID, providerId: picked.providerID },
				}),
			);
			await Effect.runPromise(
				browser.rpc.SwitchVariant({ projectSlug, sessionId, variant: "high" }),
			);
		},
	);
	await pickOpenCodeModel(page, picker);

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	if (!setup) throw new Error("openDraft never ran its setup");
	const sessionId = /\/s\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	const { variant } = await Effect.runPromise(
		setup.browser.rpc.GetModels({ projectSlug: setup.projectSlug, sessionId }),
	);
	expect
		.soft(variant?.variant, "conduit shows the model's saved effort")
		.toBe("high");
	expect
		.soft(evidence.promptVariants, "prompt_async carries that effort")
		.toEqual(["high"]);
});

test("an image attached in an OpenCode draft reaches OpenCode", async ({
	page,
	harness,
}, testInfo) => {
	const picker = await openDraft(page, harness, async (browser, slug) => {
		await Effect.runPromise(
			browser.rpc.SetProjectInstance({ slug, instanceId: "opencode" }),
		);
	});
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");
	const chooser = page.waitForEvent("filechooser");
	await page.locator("#attach-btn:visible").click();
	await page.getByRole("menuitem", { name: "Add Photos" }).click();
	await (await chooser).setFiles({
		name: "pixel.png",
		mimeType: "image/png",
		buffer: Buffer.from(pixel, "base64"),
	});
	await expect(page.getByRole("img", { name: "pixel.png" })).toBeVisible();

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect.soft(evidence.promptFiles, "prompt_async carries the image").toEqual([
		{
			type: "file",
			mime: "image/png",
			url: `data:image/png;base64,${pixel}`,
		},
	]);
});

test("a draft in a project bound to OpenCode never sends OpenCode a Claude model", async ({
	page,
	harness,
}, testInfo) => {
	// The binding lives on the daemon; the relay default stays a Claude model.
	const picker = await openDraft(page, harness, async (browser, slug) => {
		await Effect.runPromise(
			browser.rpc.SetProjectInstance({ slug, instanceId: "opencode" }),
		);
	});
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");

	const evidence = await sendAndCapture(page, harness, picker, testInfo);
	expect
		.soft(
			evidence.promptModels.filter(isClaudeModel),
			"prompt_async never carries a Claude-harness model",
		)
		.toEqual([]);
	expect
		.soft(evidence.instanceAfterSend, "the composer stays on OpenCode")
		.toBe("opencode");
	// OpenCode runs a default of its own, so the Claude default isn't its model.
	await expect
		.soft(picker, "the composer names no Claude-harness model")
		.not.toHaveAccessibleName(/opus/i);
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
	await page.getByTestId("picker-harness-opencode").click();
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

test("an OpenCode session shows OpenCode before conduit reports its harness", async ({
	page,
	harness,
}, testInfo) => {
	// The composer aims at the default Claude harness, and the session's
	// harness never arrives.
	await editRpc(page, (frame) =>
		frame._tag === "Request" &&
		frame.tag === "GetAgents" &&
		frame.payload?.["sessionId"] !== undefined
			? null
			: frame,
	);
	const picker = await openPickedSession(page, harness);

	await expect(
		picker,
		"the picker shows the session's harness, not the composer's",
	).toHaveAttribute("data-instance-id", "opencode");
	await page.screenshot({ path: testInfo.outputPath("session-harness.png") });
});

test("opening model settings in a session keeps the session's model", async ({
	page,
	harness,
}, testInfo) => {
	// Every catalogue arrives empty, as one still loading would, so the
	// settings tab fetches models. Its reply is held while `holding`.
	let holding = false;
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await editRpc(page, async (frame, request) => {
		if (holding && frame._tag === "Exit" && request?.tag === "GetModels")
			await released;
		return withoutCatalogues(frame);
	});
	const picker = await openPickedSession(page, harness);

	holding = true;
	await openSettingsPanel(page);
	await page.getByTestId("settings-tab-visibility").click();
	const panel = page.locator("#settings-panel");
	await expect(panel).toContainText("Loading models…");
	release();
	await expect(panel, "the tab applied its models reply").toContainText(
		"No models available",
	);
	await page.getByTestId("settings-close-btn").click();
	await expect(
		picker,
		"the picker still shows the session's model",
	).toHaveAccessibleName(/nemotron/i);
	await page.screenshot({
		path: testInfo.outputPath("session-model-after-settings.png"),
	});
});

test.describe("a model id both harnesses list", () => {
	// The recording's OpenCode lists anthropic/claude-3-7-sonnet-20250219.
	// Listing the same id on Claude makes the harnesses collide, as the real
	// ones do on ids like claude-sonnet-4-6.
	const shared = "claude-3-7-sonnet-20250219";
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: [
				{ id: shared, name: "Sonnet 3.7", providerId: "claude" },
			],
		},
	});

	test("after switching harness, OpenCode runs the model the composer shows", async ({
		page,
		harness,
	}, testInfo) => {
		const picker = await openDraft(page, harness);
		const list = page.getByTestId("model-picker-list");
		await picker.click();
		await page.getByTestId("picker-row-model").click();
		await list
			.locator(`[data-model-id="${shared}"][data-provider-id="claude"]`)
			.click();
		await page.getByTestId("picker-harness-opencode").click();
		await page.getByTestId("picker-row-model").click();
		const shownRow = list.locator('[aria-current="true"]');
		await expect(shownRow).toHaveCount(1);
		const shown = {
			providerID: await shownRow.getAttribute("data-provider-id"),
			modelID: await shownRow.getAttribute("data-model-id"),
		};
		await page.keyboard.press("Escape");
		await expect(picker).toHaveAttribute("data-instance-id", "opencode");

		const evidence = await sendAndCapture(page, harness, picker, testInfo);
		expect
			.soft(evidence.promptModels, "prompt_async carries the shown model")
			.toEqual([shown]);
		expect
			.soft(isClaudeModel(shown), "the composer shows an OpenCode model")
			.toBe(false);
	});
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
	 *  ran with, recorded as a JSON artifact plus before and after screenshots.
	 *  `draft` names the artifacts and keeps each draft's prompt distinct. */
	async function sendAndReadFirstTurn(
		page: Page,
		harness: ProcessHarness,
		testInfo: TestInfo,
		draft = "draft",
	) {
		await page.screenshot({
			path: testInfo.outputPath(`${draft}-effort-before-send.png`),
		});
		const effortPrompt = `Which effort is the ${draft} on?`;
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
			testInfo.outputPath(`${draft}-effort-evidence.json`),
			JSON.stringify({ firstTurn }, null, 2),
		);
		await page.screenshot({ path: testInfo.outputPath(`${draft}-effort.png`) });
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

	test("an effort picked while the picked model's efforts load is the effort the first turn runs", async ({
		page,
		harness,
	}, testInfo) => {
		// Hold the reply to the draft's model pick, which carries its efforts.
		let held = 0;
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		await editRpc(page, async (frame, request) => {
			if (frame._tag === "Exit" && request?.tag === "SwitchModel") {
				held += 1;
				await released;
			}
			return frame;
		});
		const picker = await openDraft(page, harness, saveEfforts);
		await picker.click();
		await page.getByTestId("picker-row-model").click();
		await page
			.getByTestId("model-picker-list")
			.locator('[data-model-id="sonnet"][data-provider-id="claude"]')
			.click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();
		await expect.poll(() => held).toBe(1);

		// Opus's efforts still show, and high is one of Sonnet's too.
		await picker.click();
		await page.getByTestId("picker-effort-option-high").click();
		release();
		await expect(
			page.locator('[data-testid^="picker-effort-option-"]:visible'),
			"the effort control offers Sonnet's efforts",
		).toHaveText(["low", "high"]);
		await expect
			.soft(
				page.locator('[data-testid="picker-effort-option-high"]:visible'),
				"the picked effort stays selected",
			)
			.toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();

		expect(
			await sendAndReadFirstTurn(page, harness, testInfo),
			"the first turn runs Sonnet at the picked effort",
		).toEqual([{ model: "sonnet", effort: "high" }]);
	});

	test("a model picked in the draft shows its own efforts, at its saved effort", async ({
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
		await picker.click();

		await expect
			.soft(
				page.locator('[data-testid^="picker-effort-option-"]:visible'),
				"the effort control offers Sonnet's efforts",
			)
			.toHaveText(["low", "high"]);
		await expect
			.soft(
				page.locator('[data-testid="picker-effort-option-low"]:visible'),
				"Sonnet's saved effort is selected",
			)
			.toHaveAttribute("aria-checked", "true");
		await page.screenshot({
			path: testInfo.outputPath("draft-effort-options.png"),
		});
	});

	test("an effort picked in a draft is saved for the model's next session", async ({
		page,
		harness,
	}, testInfo) => {
		const picker = await openDraft(page, harness, saveEfforts);
		const draftUrl = page.url();
		await picker.click();
		await page.getByTestId("picker-effort-option-high").click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();
		expect(
			await sendAndReadFirstTurn(page, harness, testInfo, "first-draft"),
			"the first draft runs at the picked effort",
		).toEqual([{ model: "opus", effort: "high" }]);

		// A fresh page load drops this tab's picks, so only saved efforts remain.
		await new AppPage(page).goto(draftUrl);
		expect(
			await sendAndReadFirstTurn(page, harness, testInfo, "next-draft"),
			"the next draft starts at the effort picked last",
		).toEqual([{ model: "opus", effort: "high" }]);
	});

	test("an OpenCode session without a pick never sends the Claude default's effort", async ({
		page,
		harness,
	}, testInfo) => {
		// Opus, the Claude-harness default, saved max. OpenCode runs a model of
		// its own here, so max is not its effort to run at.
		const picker = await openDraft(page, harness, async (browser, slug) => {
			await saveEfforts(browser, slug);
			await Effect.runPromise(
				browser.rpc.SetProjectInstance({ slug, instanceId: "opencode" }),
			);
		});
		await expect(picker).toHaveAttribute("data-instance-id", "opencode");

		const evidence = await sendAndCapture(page, harness, picker, testInfo);
		expect
			.soft(evidence.promptVariants, "prompt_async carries no effort")
			.toEqual([null]);

		// A fresh load shows only what conduit reports for the session. The model
		// list arrives in the same reply as the session's efforts.
		await page.reload();
		await picker.click();
		await page.getByTestId("picker-row-model").click();
		await expect(
			page.getByTestId("model-picker-list").locator("[data-model-id]").first(),
		).toBeVisible();
		await page.getByTestId("picker-back").click();
		await expect
			.soft(
				page.locator('[data-testid^="picker-effort-option-"]:visible'),
				"the session offers none of the Claude default's efforts",
			)
			.toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath("opencode-session-efforts.png"),
		});
	});
});

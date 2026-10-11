import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { Effect, type Either } from "effect";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const claudeModels: readonly ModelInfo[] = [
	{
		id: "sonnet",
		name: "Sonnet",
		providerId: "claude",
		variants: { low: {}, high: {} },
		contextWindowOptions: [
			{ value: "200k", label: "200k", isDefault: true },
			{ value: "1m", label: "1M" },
		],
	},
	{
		id: "opus",
		name: "Opus",
		providerId: "claude",
		variants: { high: {}, max: {} },
		contextWindowOptions: [
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		],
	},
];
const openCodeModel = {
	providerID: "opencode",
	modelID: "nemotron-3-super-free",
};
const otherOpenCodeModel = {
	providerID: "opencode",
	modelID: "mimo-v2-omni-free",
};
const pickerSelector =
	'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible';

// Each case starts a daemon and provider processes. Keep cases sequential
// within a viewport, while desktop and mobile still run independently.
test.describe.configure({ mode: "default" });
test.setTimeout(120_000);
test.use({
	harnessOptions: {
		opencodeRecording: "chat-simple",
		capabilityModels: claudeModels,
		restartProof: true,
	},
});

type Driver = "claude" | "opencode";
type Pick = {
	harness: string;
	provider: string;
	model: string;
	effort: string;
	contextWindow: string;
};
type GuardCase = {
	case: string;
	bead?: string;
	harness: Driver;
	flow: string;
	change: string;
};
type RpcFrame = {
	readonly _tag?: string;
	readonly id?: string;
	readonly tag?: string;
	readonly requestId?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
};

async function writeGuardArtifact(
	testInfo: TestInfo,
	artifact: Readonly<Record<string, unknown>>,
): Promise<void> {
	const file = testInfo.outputPath("pick-guard.json");
	writeFileSync(file, JSON.stringify(artifact, null, 2));
	await testInfo.attach("pick-guard.json", {
		path: file,
		contentType: "application/json",
	});
}

type StoredPickRow = {
	provider: string;
	model_id: string | null;
	model_provider: string | null;
	variant: string | null;
	context_window: string | null;
};
type EventRow = { sequence: number; type: string; data: string };

function readStoredState(
	harness: ProcessHarness,
	slug: string,
	sessionId: string,
) {
	const db = new Database(harness.projectStorePath(slug), { readonly: true });
	try {
		const events = db
			.prepare<[string], EventRow>(
				`SELECT sequence, type, data FROM events WHERE session_id = ?
				 AND type IN ('session.model_changed', 'session.variant_changed',
				 'session.context_window_changed', 'turn.error') ORDER BY sequence`,
			)
			.all(sessionId);
		return {
			sessionCount:
				db
					.prepare<[], { count: number }>(
						"SELECT count(*) AS count FROM sessions",
					)
					.get()?.count ?? 0,
			pick: db
				.prepare<[string], StoredPickRow>(
					`SELECT provider, model_id, model_provider, variant, context_window
					 FROM sessions WHERE id = ?`,
				)
				.get(sessionId),
			pickEvents: events.filter((event) => event.type !== "turn.error"),
			turnErrors: events.filter((event) => event.type === "turn.error"),
			lastInput: db
				.prepare<[string], EventRow>(
					`SELECT sequence, type, data FROM events WHERE session_id = ?
					 AND type = 'input.admitted' ORDER BY sequence DESC LIMIT 1`,
				)
				.get(sessionId),
		};
	} finally {
		db.close();
	}
}

// Same pass-through RPC interception as harness-draft-model, including the
// request associated with each reply. It never changes product responses.
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

async function openDraft(
	page: Page,
	harness: ProcessHarness,
	driver: Driver,
	prepare?: (browser: ProcessBrowser, slug: string) => Promise<void>,
	expectedHarness: Driver | null = driver,
) {
	const directory = mkdtempSync(join(harness.root, "pick-guard-project-"));
	const browser = await harness.connect();
	const { savedSlug: slug } = await Effect.runPromise(
		browser.rpc.SaveProject({ folders: [directory] }),
	);
	if (!slug) throw new Error("SaveProject did not return a slug");
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: driver === "claude" ? "sonnet" : openCodeModel.modelID,
			provider: driver === "claude" ? "claude" : openCodeModel.providerID,
		}),
	);
	if (driver === "opencode") await browser.startInstance("opencode");
	await prepare?.(browser, slug);
	await new AppPage(page).goto(
		`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`,
	);
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/new\?/);
	const picker = page.locator(pickerSelector);
	await expect(picker).toHaveAttribute("data-shown-model", /.+/);
	if (expectedHarness)
		await expect(picker).toHaveAttribute("data-shown-harness", expectedHarness);
	return { browser, slug, picker };
}

async function closePicker(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
}

async function pickModel(
	page: Page,
	picker: Locator,
	model: { providerID: string; modelID: string },
): Promise<void> {
	await picker.click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator(
			`[data-model-id="${model.modelID}"][data-provider-id="${model.providerID}"]`,
		)
		.click();
	await closePicker(page);
	await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
}

async function pickOpenCodeModel(page: Page, picker: Locator): Promise<void> {
	await picker.click();
	await page.getByTestId("picker-row-harness").click();
	await page.getByTestId("picker-instance-opencode").click();
	await closePicker(page);
	await pickModel(page, picker, otherOpenCodeModel);
}

async function readShown(picker: Locator): Promise<Pick> {
	return picker.evaluate((button) => {
		const shown = (key: string): string => {
			const value = button.getAttribute(`data-shown-${key}`);
			if (value === null) throw new Error(`Missing data-shown-${key}`);
			return value;
		};
		return {
			harness: shown("harness"),
			provider: shown("provider"),
			model: shown("model"),
			effort: shown("effort"),
			contextWindow: shown("context-window"),
		};
	});
}

function enqueues(harness: ProcessHarness, durable: boolean) {
	const file = join(harness.root, "sdk-proof.ndjson");
	const marks: readonly ProcessMark[] = durable
		? existsSync(file)
			? readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ProcessMark)
			: []
		: harness.marks;
	return marks.filter((mark) => mark.kind === "enqueue");
}

function openCodePrompts(harness: ProcessHarness) {
	return harness
		.opencodeRequestBodies()
		.filter(
			({ method, path }) =>
				method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path),
		);
}

async function sendAndCapture(
	page: Page,
	harness: ProcessHarness,
	driver: Driver,
	prompt: string,
	durable = false,
): Promise<Pick> {
	const claudeBefore = enqueues(harness, durable).length;
	const openCodeBefore = openCodePrompts(harness).length;
	await new AppPage(page).sendMessage(prompt);
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	const chat = new ChatPage(page);
	if (driver === "claude" || openCodeBefore === 0) {
		await expect(chat.assistantMessages.last()).toContainText(
			driver === "claude" ? `done(${prompt})` : "pong",
			{ timeout: 30_000 },
		);
		await chat.waitForStreamingComplete();
	}
	// chat-simple has one recorded reply. On a second OpenCode turn the
	// provider receipt, rather than another replayed reply, is the boundary.
	await expect
		.poll(
			() =>
				enqueues(harness, durable)
					.slice(claudeBefore)
					.filter((mark) => mark.prompt === prompt).length +
				openCodePrompts(harness).slice(openCodeBefore).length,
		)
		.toBe(1);
	const claude = enqueues(harness, durable)
		.slice(claudeBefore)
		.filter((mark) => mark.prompt === prompt);
	const openCode = openCodePrompts(harness).slice(openCodeBefore);
	expect(
		claude.length + openCode.length,
		"exactly one provider received this turn",
	).toBe(1);
	const enqueue = claude[0];
	if (enqueue) {
		const apiModel = enqueue.liveOptions.model;
		if (!apiModel) throw new Error("Claude enqueue omitted liveOptions.model");
		const model = apiModel.replace(/\[1m\]$/i, "");
		const catalog = claudeModels.find((entry) => entry.id === model);
		if (!catalog)
			throw new Error(`Claude received uncatalogued model ${apiModel}`);
		return {
			harness: "claude",
			provider: "claude",
			model,
			effort: enqueue.liveOptions.effort ?? "",
			contextWindow: /\[1m\]$/i.test(apiModel)
				? "1m"
				: (catalog.contextWindowOptions?.find((option) => option.isDefault)
						?.value ?? ""),
		};
	}
	const request = openCode[0];
	if (!request) throw new Error("No provider capture for this turn");
	const body = JSON.parse(request.body) as {
		model?: { providerID: string; modelID: string };
		variant?: string;
	};
	return {
		harness: "opencode",
		provider: body.model?.providerID ?? "",
		model: body.model?.modelID ?? "",
		effort: body.variant ?? "",
		contextWindow: "n/a",
	};
}

async function assertParity(
	guard: GuardCase,
	shown: Pick,
	sent: Pick,
	testInfo: TestInfo,
	retainedModel?: string,
): Promise<void> {
	const keys: (keyof Pick)[] = ["harness", "provider", "model", "effort"];
	if (sent.harness === "claude") keys.push("contextWindow");
	const mismatches = keys.flatMap((key) =>
		shown[key] === sent[key]
			? []
			: [
					`${key}: shown ${JSON.stringify(shown[key])}, sent ${JSON.stringify(sent[key])}`,
				],
	);
	if (retainedModel !== undefined) {
		for (const [source, pick] of [
			["shown", shown],
			["sent", sent],
		] as const) {
			if (pick.model !== retainedModel)
				mismatches.push(
					`${source}.model: ${JSON.stringify(pick.model)}, session model ${JSON.stringify(retainedModel)}`,
				);
		}
	}
	const artifact = {
		...guard,
		shown,
		sent,
		equal: mismatches.length === 0,
		mismatches,
	};
	const file = testInfo.outputPath("pick-guard.json");
	writeFileSync(file, JSON.stringify(artifact, null, 2));
	await testInfo.attach("pick-guard.json", {
		path: file,
		contentType: "application/json",
	});
	expect(
		mismatches,
		`${guard.case}: composer and provider picks agree`,
	).toEqual([]);
}

async function openPickedSession(
	page: Page,
	harness: ProcessHarness,
	driver: Driver,
	caseId: string,
) {
	const draft = await openDraft(page, harness, driver);
	await sendAndCapture(page, harness, driver, `${caseId}-first`);
	await expect(draft.picker).toHaveAttribute("data-shown-harness", driver);
	return draft;
}

async function openInheritedSession(
	page: Page,
	harness: ProcessHarness,
	caseId: string,
) {
	const draft = await openDraft(page, harness, "claude");
	const { sessionId } = await Effect.runPromise(
		draft.browser.rpc.CreateSession({
			projectSlug: draft.slug,
			originId: `${caseId}-setup`,
			instanceId: ProviderInstanceIdSchema.make("claude"),
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		}),
	);
	await new AppPage(page).goto(
		`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(draft.slug)}`,
	);
	await expect(draft.picker).toHaveAttribute("data-shown-model", "sonnet");
	return draft;
}

for (const driver of ["claude", "opencode"] as const) {
	for (const existing of [false, true]) {
		for (const change of ["none", "model", "effort", "context"] as const) {
			const caseId = `${driver === "claude" ? "c" : "o"}${existing ? "s" : "d"}-${change}`;
			const flow = existing
				? "existing session second turn"
				: "draft first send";
			const dropsDraftContext =
				driver === "claude" && !existing && change === "context";
			const omitsModel =
				driver === "opencode" &&
				(change === "none" ||
					change === "context" ||
					(existing && change === "effort"));
			const bead = dropsDraftContext
				? "conduit-test-scw7"
				: omitsModel
					? "conduit-test-fmg0.8"
					: undefined;
			test(`${caseId}: ${driver}, ${flow}, ${change}`, async ({
				page,
				harness,
			}, testInfo) => {
				const { picker } = existing
					? await openPickedSession(page, harness, driver, caseId)
					: await openDraft(page, harness, driver);
				if (change === "model") {
					if (driver === "opencode" && !existing)
						await pickOpenCodeModel(page, picker);
					else
						await pickModel(
							page,
							picker,
							driver === "claude"
								? { providerID: "claude", modelID: "opus" }
								: otherOpenCodeModel,
						);
				}
				// Opening the root also waits for the offered efforts to load. Select
				// only concrete options supplied by the current model's catalogue.
				await picker.click();
				await expect(
					page.getByTestId("picker-effort-option-high"),
				).toBeVisible();
				if (change === "effort") {
					await page.getByTestId("picker-effort-option-high").click();
					await expect(picker).toHaveAttribute("data-shown-effort", "high");
				}
				if (change === "context") {
					if (driver === "claude") {
						await page.getByTestId("picker-context-option-1m").click();
						await expect(picker).toHaveAttribute(
							"data-shown-context-window",
							"1m",
						);
					} else {
						await expect(
							page.locator('[data-testid^="picker-context-option-"]:visible'),
						).toHaveCount(0);
						await expect(picker).toHaveAttribute(
							"data-shown-context-window",
							"",
						);
					}
				}
				await closePicker(page);
				const shown = await readShown(picker);
				const sent = await sendAndCapture(
					page,
					harness,
					driver,
					`${caseId}-${existing ? "second" : "first"}`,
				);
				await assertParity(
					{
						case: caseId,
						...(bead ? { bead } : {}),
						harness: driver,
						flow,
						change:
							change === "none"
								? "none"
								: `${change === "context" ? "context window" : change} switched`,
					},
					shown,
					sent,
					testInfo,
				);
			});
		}
	}
}

test("zjdq: OpenCode draft with a Claude default", async ({
	page,
	harness,
}, testInfo) => {
	test.fail(
		true,
		"conduit-test-zjdq: the OpenCode draft displays the Claude default instead of its received model",
	);
	const { browser, slug, picker } = await openDraft(
		page,
		harness,
		"opencode",
		async (browser, slug) => {
			await Effect.runPromise(
				browser.rpc.SetDefaultModel({
					projectSlug: slug,
					model: "opus",
					provider: "claude",
				}),
			);
		},
		// Record the wrong harness in the artifact before the parity assertion.
		null,
	);
	await expect(picker).toHaveAttribute("data-shown-model", /.+/);
	const shown = await readShown(picker);
	if (shown.harness === "opencode" && shown.provider !== "claude") {
		const sent = await sendAndCapture(page, harness, "opencode", "zjdq-first");
		await assertParity(
			{
				case: "zjdq",
				bead: "conduit-test-zjdq",
				harness: "opencode",
				flow: "draft first send",
				change: "Claude default set",
			},
			shown,
			sent,
			testInfo,
		);
		return;
	}
	const result = await Effect.runPromise(
		Effect.either(
			browser.rpc.CreateSession({
				projectSlug: slug,
				originId: "zjdq-shown-pick",
				instanceId: ProviderInstanceIdSchema.make("opencode"),
				model: {
					providerId: shown.provider,
					modelId: shown.model,
					variant: shown.effort,
					contextWindow: shown.contextWindow,
				},
			}),
		),
	);
	const error = result._tag === "Left" ? result.left : undefined;
	const mismatches: string[] = [];
	if (shown.harness !== "opencode")
		mismatches.push(
			`harness: shown ${JSON.stringify(shown.harness)}, bound harness "opencode"`,
		);
	if (shown.provider === "claude")
		mismatches.push(
			`provider: shown ${JSON.stringify(shown.provider)}, bound harness "opencode"`,
		);
	await writeGuardArtifact(testInfo, {
		case: "zjdq",
		bead: "conduit-test-zjdq",
		harness: "opencode",
		flow: "draft CreateSession with the displayed pick",
		change: "Claude default set",
		shown,
		sent: null,
		expectedRejection: "ModelNotInCatalog",
		rpcResult:
			error instanceof WsRpcError
				? { _tag: "Left", error: { _tag: error._tag, message: error.message } }
				: result,
		equal: mismatches.length === 0,
		mismatches,
	});
	expect(error).toBeInstanceOf(WsRpcError);
	if (error instanceof WsRpcError)
		expect(error.message).toMatch(/^ModelNotInCatalog:/);
	expect(
		mismatches,
		"zjdq: the displayed provider belongs to its harness",
	).toEqual([]);
});

test("ob6u: another client changes an inherited session's default", async ({
	page,
	harness,
}, testInfo) => {
	let changedElsewhere = false;
	await editRpc(page, (frame) => {
		const json = JSON.stringify(frame);
		if (json.includes('"defaultModel"') && json.includes('"opus"'))
			changedElsewhere = true;
		return frame;
	});
	const { browser, slug, picker } = await openInheritedSession(
		page,
		harness,
		"ob6u",
	);
	const retained = (await readShown(picker)).model;
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	await expect.poll(() => changedElsewhere).toBe(true);
	const shown = await readShown(picker);
	const sent = await sendAndCapture(page, harness, "claude", "ob6u-next");
	await assertParity(
		{
			case: "ob6u",
			bead: "conduit-test-ob6u",
			harness: "claude",
			flow: "existing session next turn",
			change: "default changed by another client",
		},
		shown,
		sent,
		testInfo,
		retained,
	);
});

test("unse: restart with a different default keeps the inherited model", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(180_000);
	const { browser, slug, picker } = await openInheritedSession(
		page,
		harness,
		"unse",
	);
	const before = await sendAndCapture(
		page,
		harness,
		"claude",
		"unse-before",
		true,
	);
	const sessionUrl = page.url();
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	await browser.close();
	await harness.terminate();
	await harness.restart({
		startupTimeoutMs: 60_000,
		runnerStartupTimeoutMs: 30_000,
	});
	await new AppPage(page).goto(
		`${harness.baseUrl}${new URL(sessionUrl).pathname}${new URL(sessionUrl).search}`,
	);
	await expect(picker).toHaveAttribute("data-shown-harness", "claude");
	await expect(picker).toHaveAttribute("data-shown-model", /.+/);
	const shown = await readShown(picker);
	const sent = await sendAndCapture(
		page,
		harness,
		"claude",
		"unse-after",
		true,
	);
	await assertParity(
		{
			case: "unse",
			bead: "conduit-test-unse",
			harness: "claude",
			flow: "existing session after restart",
			change: "restart with a different default",
		},
		shown,
		sent,
		testInfo,
		before.model,
	);
});

async function createStoredPickSession(
	page: Page,
	harness: ProcessHarness,
	caseId: string,
	contextWindow = "200k",
) {
	const draft = await openDraft(page, harness, "claude");
	const { sessionId } = await Effect.runPromise(
		draft.browser.rpc.CreateSession({
			projectSlug: draft.slug,
			originId: caseId,
			instanceId: ProviderInstanceIdSchema.make("claude"),
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "high",
				contextWindow,
			},
		}),
	);
	await new AppPage(page).goto(
		`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(draft.slug)}`,
	);
	await expect(draft.picker).toHaveAttribute("data-shown-model", "sonnet");
	return { ...draft, sessionId };
}

test("pick-required-create: no model rejects before session creation", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, slug } = await openDraft(page, harness, "opencode");
	const upstreamCreates = () =>
		harness
			.opencodeRequestBodies()
			.filter(
				(request) =>
					request.method === "POST" && /^\/session\/?$/.test(request.path),
			).length;
	const before = {
		sessions: readStoredState(harness, slug, "").sessionCount,
		upstreamCreates: upstreamCreates(),
	};
	const requests = [
		undefined,
		{ modelId: "", providerId: "opencode" },
		{ modelId: " \t ", providerId: "opencode" },
		{ modelId: openCodeModel.modelID, providerId: "" },
	] as const;
	const errors: unknown[] = [];
	for (const model of requests) {
		try {
			const result = await Effect.runPromise(
				Effect.either(
					browser.rpc
						.CreateSession({
							projectSlug: slug,
							originId: "pick-required-create",
							instanceId: ProviderInstanceIdSchema.make("opencode"),
							...(model ? { model } : {}),
						})
						.pipe(Effect.timeout("10 seconds")),
				),
			);
			errors.push(result._tag === "Left" ? result.left : undefined);
		} catch (error) {
			errors.push(error);
		}
	}
	const after = {
		sessions: readStoredState(harness, slug, "").sessionCount,
		upstreamCreates: upstreamCreates(),
	};
	await writeGuardArtifact(testInfo, {
		case: "pick-required-create",
		bead: "conduit-test-fmg0.4",
		before,
		after,
		expectedRejection: "PickRequired",
		rpcResults: errors.map((error, index) => ({
			model: requests[index] ?? null,
			error:
				error instanceof Error
					? { name: error.name, message: error.message }
					: error,
		})),
	});
	for (const error of errors) {
		expect(error).toBeInstanceOf(WsRpcError);
		if (error instanceof WsRpcError)
			expect(error.message).toMatch(/^PickRequired:/);
	}
	expect(after).toEqual(before);
});

test("legacy-pick-backfill: last turn restores once and survives a second restart", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(240_000);
	const { browser, slug, sessionId } = await createStoredPickSession(
		page,
		harness,
		"legacy-pick-backfill",
	);
	const sent = await sendAndCapture(
		page,
		harness,
		"claude",
		"legacy-pick-before",
		true,
	);
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	const before = readStoredState(harness, slug, sessionId);
	await browser.close();
	await harness.terminate();
	const db = new Database(harness.projectStorePath(slug));
	try {
		expect(
			db
				.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
			variant = NULL, context_window = NULL WHERE id = ?`)
				.run(sessionId).changes,
		).toBe(1);
	} finally {
		db.close();
	}
	const legacy = readStoredState(harness, slug, sessionId);
	const restorations: ReturnType<typeof readStoredState>[] = [];
	const reported: {
		model: string;
		provider: string;
		effort: string;
		contextWindow: string;
	}[] = [];
	try {
		for (let restart = 0; restart < 2; restart++) {
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const restoredBrowser = await harness.connect(
				sessionId,
				`legacy-read-${restart}`,
				slug,
			);
			const models = await Effect.runPromise(
				restoredBrowser.rpc.GetModels({ projectSlug: slug, sessionId }),
			);
			restorations.push(readStoredState(harness, slug, sessionId));
			reported.push({
				model: models.active?.model ?? "",
				provider: models.active?.provider ?? "",
				effort: models.variant?.variant ?? "",
				contextWindow: models.contextWindow?.contextWindow ?? "",
			});
			await restoredBrowser.close();
			if (restart === 0) await harness.terminate();
		}
	} finally {
		await writeGuardArtifact(testInfo, {
			case: "legacy-pick-backfill",
			bead: "conduit-test-fmg0.4",
			sent,
			before,
			legacy,
			restorations,
			reported,
		});
	}
	const expected = {
		provider: "claude",
		model_id: "sonnet",
		model_provider: "claude",
		variant: "high",
		context_window: "200k",
	};
	expect(sent).toMatchObject({
		model: "sonnet",
		effort: "high",
		contextWindow: "200k",
	});
	expect(legacy.pick).toMatchObject({ model_id: null, variant: null });
	expect(restorations[0]?.pick).toEqual(expected);
	expect(restorations[0]?.pickEvents.length).toBeGreaterThan(
		before.pickEvents.length,
	);
	expect(restorations[1]?.pick).toEqual(expected);
	expect(restorations[1]?.pickEvents).toEqual(restorations[0]?.pickEvents);
	expect(reported).toEqual([
		{
			model: "sonnet",
			provider: "claude",
			effort: "high",
			contextWindow: "200k",
		},
		{
			model: "sonnet",
			provider: "claude",
			effort: "high",
			contextWindow: "200k",
		},
	]);
});

test("legacy-opencode-pick-backfill: message input receipt restores once across two restarts", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(240_000);
	const caseId = "legacy-opencode-pick-backfill";
	const { browser, slug, picker } = await openDraft(page, harness, "opencode");
	const { sessionId } = await Effect.runPromise(
		browser.rpc.CreateSession({
			projectSlug: slug,
			originId: caseId,
			instanceId: ProviderInstanceIdSchema.make("opencode"),
			model: {
				providerId: openCodeModel.providerID,
				modelId: openCodeModel.modelID,
				variant: "high",
				contextWindow: "",
			},
		}),
	);
	await new AppPage(page).goto(
		`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(slug)}`,
	);
	await expect(picker).toHaveAttribute(
		"data-shown-model",
		openCodeModel.modelID,
	);
	const sent = await sendAndCapture(
		page,
		harness,
		"opencode",
		`${caseId}-before`,
	);
	const before = readStoredState(harness, slug, sessionId);
	const receiptDb = new Database(harness.projectStorePath(slug), {
		readonly: true,
	});
	let lastTurn:
		| {
				turnId: string;
				userMessageId: string;
				inputId: string | null;
				receiptCommandId: string | null;
				outboxRequestSequence: number | null;
				commandPayload: string | null;
		  }
		| undefined;
	try {
		lastTurn = receiptDb
			.prepare<[string], NonNullable<typeof lastTurn>>(
				`SELECT t.id AS turnId, u.id AS userMessageId, u.input_id AS inputId,
				 r.command_id AS receiptCommandId, o.request_sequence AS outboxRequestSequence,
				 o.payload_json AS commandPayload
				 FROM turns t JOIN messages u ON u.id = t.user_message_id
				 LEFT JOIN command_receipts r ON r.command_id = u.input_id AND r.command_type = 'send_turn'
				 LEFT JOIN provider_command_outbox o ON o.request_sequence = r.side_effect_sequence
				 WHERE t.session_id = ? AND t.started_at IS NOT NULL
				 ORDER BY t.requested_at DESC, t.rowid DESC LIMIT 1`,
			)
			.get(sessionId);
	} finally {
		receiptDb.close();
	}
	const dispatched = lastTurn?.commandPayload
		? (JSON.parse(lastTurn.commandPayload) as {
				model: { providerId: string; modelId: string };
				variant: string;
				contextWindow: string;
			})
		: undefined;
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: otherOpenCodeModel.modelID,
			provider: otherOpenCodeModel.providerID,
		}),
	);
	await browser.close();
	await harness.terminate();
	const db = new Database(harness.projectStorePath(slug));
	try {
		expect(
			db
				.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
			variant = NULL, context_window = NULL WHERE id = ?`)
				.run(sessionId).changes,
		).toBe(1);
	} finally {
		db.close();
	}
	const legacy = readStoredState(harness, slug, sessionId);
	const restorations: ReturnType<typeof readStoredState>[] = [];
	const reported: {
		model: string;
		provider: string;
		effort: string;
		contextWindow: string;
	}[] = [];
	const expected = {
		provider: "opencode",
		model_id: openCodeModel.modelID,
		model_provider: openCodeModel.providerID,
		variant: "high",
		context_window: "",
	};
	try {
		for (let restart = 0; restart < 2; restart++) {
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			const restoredBrowser = await harness.connect(
				sessionId,
				`${caseId}-read-${restart}`,
				slug,
			);
			const models = await Effect.runPromise(
				restoredBrowser.rpc.GetModels({ projectSlug: slug, sessionId }),
			);
			restorations.push(readStoredState(harness, slug, sessionId));
			reported.push({
				model: models.active?.model ?? "",
				provider: models.active?.provider ?? "",
				effort: models.variant?.variant ?? "",
				contextWindow: models.contextWindow?.contextWindow ?? "",
			});
			await restoredBrowser.close();
			if (restart === 0) await harness.terminate();
		}
	} finally {
		await writeGuardArtifact(testInfo, {
			case: caseId,
			bead: "conduit-test-fmg0.4",
			harness: "opencode",
			flow: "legacy session restarted twice after an explicit provider turn",
			change: "stored pick cleared and harness default changed",
			expected,
			sent,
			lastTurn,
			dispatched,
			before,
			legacy,
			restorations,
			reported,
		});
	}
	expect(sent).toMatchObject({
		provider: openCodeModel.providerID,
		model: openCodeModel.modelID,
		effort: "high",
	});
	expect(lastTurn?.inputId).toBeTruthy();
	expect(lastTurn?.turnId).not.toBe(lastTurn?.inputId);
	expect(lastTurn?.receiptCommandId).toBe(lastTurn?.inputId);
	expect(dispatched).toMatchObject({
		model: {
			providerId: openCodeModel.providerID,
			modelId: openCodeModel.modelID,
		},
		variant: "high",
		contextWindow: "",
	});
	expect(legacy.pick).toMatchObject({ model_id: null, variant: null });
	expect(restorations[0]?.pick).toEqual(expected);
	expect(restorations[0]?.pickEvents.length).toBe(before.pickEvents.length + 3);
	expect(restorations[1]?.pick).toEqual(expected);
	expect(restorations[1]?.pickEvents).toEqual(restorations[0]?.pickEvents);
	expect(reported).toEqual([
		{
			model: openCodeModel.modelID,
			provider: openCodeModel.providerID,
			effort: "high",
			contextWindow: "",
		},
		{
			model: openCodeModel.modelID,
			provider: openCodeModel.providerID,
			effort: "high",
			contextWindow: "",
		},
	]);
});

for (const rejection of ["uncatalogued", "missing"] as const) {
	const caseId =
		rejection === "uncatalogued"
			? "reject-turn-no-model-event"
			: "pick-required-turn";
	test(`${caseId}: rejected turn writes no model change or provider prompt`, async ({
		page,
		harness,
	}, testInfo) => {
		const { browser, slug, sessionId } = await createStoredPickSession(
			page,
			harness,
			caseId,
		);
		await Effect.runPromise(
			browser.rpc.GetModels({ projectSlug: slug, sessionId }),
		);
		const before = readStoredState(harness, slug, sessionId);
		const receiptsBefore = enqueues(harness, true).length;
		const db = new Database(harness.projectStorePath(slug));
		try {
			const changed =
				rejection === "uncatalogued"
					? db
							.prepare("UPDATE sessions SET model_id = ? WHERE id = ?")
							.run("not-in-catalog", sessionId)
					: db
							.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
				variant = NULL, context_window = NULL WHERE id = ?`)
							.run(sessionId);
			expect(changed.changes).toBe(1);
		} finally {
			db.close();
		}
		const submit = await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: slug,
				sessionId,
				inputId: caseId,
				originId: "pick-guard",
				delivery: "queue",
				text: caseId,
			}),
		);
		let after = readStoredState(harness, slug, sessionId);
		try {
			await expect
				.poll(
					() => {
						after = readStoredState(harness, slug, sessionId);
						return after.turnErrors.length;
					},
					{ timeout: 15_000 },
				)
				.toBe(before.turnErrors.length + 1);
		} finally {
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.4",
				expectedCode:
					rejection === "uncatalogued" ? "PICK_REJECTED" : "PICK_REQUIRED",
				submit,
				before,
				after,
				receiptsBefore,
				receiptsAfter: enqueues(harness, true).length,
			});
		}
		const error = JSON.parse(after.turnErrors.at(-1)?.data ?? "{}") as {
			code?: string;
			error?: string;
		};
		expect(error.code).toBe(
			rejection === "uncatalogued" ? "PICK_REJECTED" : "PICK_REQUIRED",
		);
		if (rejection === "uncatalogued")
			expect(error.error).toMatch(/^ModelNotInCatalog:/);
		else {
			expect(error.error).toMatch(/pick/i);
			expect(error.error).not.toMatch(/^PickRequired:/);
		}
		expect(after.pickEvents).toEqual(before.pickEvents);
		expect(enqueues(harness, true).length).toBe(receiptsBefore);
	});
}

test("server-side-thread-pick: a server-created session inherits its source pick", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, slug, sessionId } = await createStoredPickSession(
		page,
		harness,
		"server-side-thread-pick",
		"1m",
	);
	// Enable the harness's native transcript recorder before the source turn.
	writeFileSync(
		join(harness.root, "claude", "conduit-test-record-forks"),
		"record",
	);
	const sent = await sendAndCapture(
		page,
		harness,
		"claude",
		"side-source-first",
		true,
	);
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	const source = readStoredState(harness, slug, sessionId);
	const side = await Effect.runPromise(
		browser.rpc.StartSideThread({
			projectSlug: slug,
			parentSessionId: sessionId,
			title: "Prove the source pick is inherited",
		}),
	);
	const created = readStoredState(harness, slug, side.sessionId);
	const models = await Effect.runPromise(
		browser.rpc.GetModels({ projectSlug: slug, sessionId: side.sessionId }),
	);
	const reported = {
		model: models.active?.model ?? "",
		provider: models.active?.provider ?? "",
		effort: models.variant?.variant ?? "",
		contextWindow: models.contextWindow?.contextWindow ?? "",
	};
	await writeGuardArtifact(testInfo, {
		case: "server-side-thread-pick",
		bead: "conduit-test-fmg0.4",
		sent,
		source,
		created,
		reported,
	});
	expect(source.pick).toEqual({
		provider: "claude",
		model_id: "sonnet",
		model_provider: "claude",
		variant: "high",
		context_window: "1m",
	});
	expect(created.pick).toEqual(source.pick);
	expect(
		created.pickEvents.some((event) => event.type === "session.model_changed"),
	).toBe(true);
	expect(reported).toEqual({
		model: "sonnet",
		provider: "claude",
		effort: "high",
		contextWindow: "1m",
	});
});

async function assertPickRejected(
	guard: GuardCase,
	result: Either.Either<unknown, unknown>,
	tag: "EffortNotOffered" | "ContextWindowNotOffered",
	testInfo: TestInfo,
	evidence: {
		shown: Pick;
		after: Pick;
		request: Readonly<Record<string, unknown>>;
		sessionsBefore: readonly string[];
		sessionsAfter: readonly string[];
	},
): Promise<void> {
	const error = result._tag === "Left" ? result.left : undefined;
	const mismatches: string[] = [];
	if (!(error instanceof WsRpcError))
		mismatches.push(`RPC did not reject with WsRpcError: ${result._tag}`);
	else if (!error.message.includes(tag))
		mismatches.push(`RPC error omitted ${tag}: ${error.message}`);
	for (const key of [
		"harness",
		"provider",
		"model",
		"effort",
		"contextWindow",
	] as const) {
		if (evidence.shown[key] !== evidence.after[key])
			mismatches.push(
				`${key}: before ${JSON.stringify(evidence.shown[key])}, after ${JSON.stringify(evidence.after[key])}`,
			);
	}
	if (
		JSON.stringify(evidence.sessionsBefore) !==
		JSON.stringify(evidence.sessionsAfter)
	)
		mismatches.push("Rejected RPC changed the session list");
	const artifact = {
		...guard,
		...evidence,
		sent: null,
		expectedRejection: tag,
		rpcResult:
			result._tag === "Left" && error instanceof WsRpcError
				? { _tag: "Left", error: { _tag: error._tag, message: error.message } }
				: result,
		equal: mismatches.length === 0,
		mismatches,
	};
	const file = testInfo.outputPath("pick-guard.json");
	writeFileSync(file, JSON.stringify(artifact, null, 2));
	await testInfo.attach("pick-guard.json", {
		path: file,
		contentType: "application/json",
	});
	expect(
		mismatches,
		`${guard.case}: rejected pick leaves settings intact`,
	).toEqual([]);
}

test.describe("server pick rejections", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: [
				...claudeModels,
				{ id: "haiku", name: "Haiku", providerId: "claude" },
			],
		},
	});

	for (const driver of ["claude", "opencode"] as const) {
		for (const rejection of [
			"effort",
			"context",
			"no-efforts",
			"create",
		] as const) {
			const caseId = `${driver === "claude" ? "c" : "o"}-reject-${rejection}`;
			test(`${caseId}: ${driver}, ${rejection} RPC rejection`, async ({
				page,
				harness,
			}, testInfo) => {
				const { browser, slug, picker } = await openDraft(
					page,
					harness,
					driver,
				);
				const model =
					rejection === "no-efforts"
						? {
								providerID: driver,
								modelID: driver === "claude" ? "haiku" : "minimax-m2.5-free",
							}
						: driver === "claude"
							? { providerID: "claude", modelID: "sonnet" }
							: openCodeModel;
				let sessionId = "";
				if (rejection !== "create") {
					({ sessionId } = await Effect.runPromise(
						browser.rpc.CreateSession({
							projectSlug: slug,
							originId: `${caseId}-setup`,
							instanceId: ProviderInstanceIdSchema.make(driver),
							model: {
								providerId: model.providerID,
								modelId: model.modelID,
								variant: rejection === "no-efforts" ? "" : "high",
							},
						}),
					));
					await new AppPage(page).goto(
						`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(slug)}`,
					);
					await expect(picker).toHaveAttribute(
						"data-shown-model",
						model.modelID,
					);
					await expect(picker).toHaveAttribute(
						"data-shown-effort",
						rejection === "no-efforts" ? "" : "high",
					);
				}
				const shown = await readShown(picker);
				const sessionsBefore = (
					await Effect.runPromise(
						browser.rpc.ListDaemonSessions({ projectSlug: slug }),
					)
				).sessions
					.map((session) => session.id)
					.sort();
				const createRequest = {
					projectSlug: slug,
					originId: caseId,
					instanceId: ProviderInstanceIdSchema.make(driver),
					model: {
						providerId: model.providerID,
						modelId: model.modelID,
						variant: "not-offered",
					},
				};
				const contextRequest = {
					projectSlug: slug,
					sessionId,
					contextWindow: "2m",
				};
				const variantRequest = {
					projectSlug: slug,
					sessionId,
					variant: rejection === "no-efforts" ? "high" : "not-offered",
				};
				const call: Effect.Effect<unknown, unknown> =
					rejection === "create"
						? browser.rpc.CreateSession(createRequest)
						: rejection === "context"
							? browser.rpc.SwitchContextWindow(contextRequest)
							: browser.rpc.SwitchVariant(variantRequest);
				const result = await Effect.runPromise(Effect.either(call));
				// Rehydrate server settings so a stale composer cannot hide mutation.
				await page.reload();
				await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
				const after = await readShown(picker);
				const sessionsAfter = (
					await Effect.runPromise(
						browser.rpc.ListDaemonSessions({ projectSlug: slug }),
					)
				).sessions
					.map((session) => session.id)
					.sort();
				await assertPickRejected(
					{
						case: caseId,
						harness: driver,
						flow:
							rejection === "create"
								? "draft CreateSession RPC"
								: "existing session settings RPC",
						change: rejection,
					},
					result,
					rejection === "context"
						? "ContextWindowNotOffered"
						: "EffortNotOffered",
					testInfo,
					{
						shown,
						after,
						request:
							rejection === "create"
								? { method: "CreateSession", ...createRequest }
								: rejection === "context"
									? { method: "SwitchContextWindow", ...contextRequest }
									: { method: "SwitchVariant", ...variantRequest },
						sessionsBefore,
						sessionsAfter,
					},
				);
			});
		}
	}
});

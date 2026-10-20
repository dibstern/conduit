import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import {
	Effect,
	Result as Either,
	Fiber,
	Option,
	Schema,
	Stream,
} from "effect";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	GetAgentsResponseSchema,
	type GetModelsResponse,
	GetModelsResponseSchema,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { isProcessAlive } from "../../../src/lib/instance/managed-opencode-process.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { openPickerRoot } from "../helpers/model-picker.js";
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
	'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible';

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
	readonly id?: string | number;
	readonly tag?: string;
	readonly requestId?: string | number;
	readonly payload?: Readonly<Record<string, unknown>>;
	readonly exit?: { readonly _tag: string; readonly value?: unknown };
	readonly values?: readonly unknown[];
};

/** A draft catalog can arrive as a unary reply or an inventory push. */
function editModelInventories(
	frame: RpcFrame,
	edit: (response: GetModelsResponse) => GetModelsResponse,
): RpcFrame {
	const replace = (value: unknown) =>
		edit(Schema.decodeUnknownSync(GetModelsResponseSchema)(value));
	if (frame._tag === "Chunk" && frame.values)
		return { ...frame, values: frame.values.map(replace) };
	if (frame.exit?._tag === "Success" && frame.exit.value !== undefined)
		return {
			...frame,
			exit: { ...frame.exit, value: replace(frame.exit.value) },
		};
	return frame;
}

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
	const db = new Database(harness.daemonStorePath(), { readonly: true });
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
					.prepare<[string], { count: number }>(
						"SELECT count(*) AS count FROM sessions WHERE project_id = ?",
					)
					.get(slug)?.count ?? 0,
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
				if (frame._tag === "Request" && frame.id !== undefined)
					requests.set(String(frame.id), frame);
				const edited = await edit(
					frame,
					frame.requestId !== undefined
						? requests.get(String(frame.requestId))
						: undefined,
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
	seedDefaults = true,
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
	if (seedDefaults) {
		for (const harness of ["claude", "opencode"] as const)
			await Effect.runPromise(
				browser.rpc.SetHarnessDefault({
					projectSlug: slug,
					harness,
					providerId:
						harness === "claude" ? "claude" : openCodeModel.providerID,
					modelId: harness === "claude" ? "sonnet" : openCodeModel.modelID,
					effort: harness === "claude" ? "low" : "",
					contextWindow: harness === "claude" ? "200k" : "",
				}),
			);
	}
	await prepare?.(browser, slug);
	await new AppPage(page).goto(
		`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`,
	);
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
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
	await openPickerRoot(page, picker);
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator(
			`[data-model-id="${model.modelID}"][data-provider-id="${model.providerID}"]`,
		)
		.click({ timeout: 10_000 });
	await closePicker(page);
	await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
}

async function pickOpenCodeModel(page: Page, picker: Locator): Promise<void> {
	await openPickerRoot(page, picker);
	await page.getByTestId("picker-harness-opencode").click();
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
		const url = new URL(page.url());
		const slug = url.searchParams.get("p");
		const sessionId = decodeURIComponent(
			url.pathname.match(/\/s\/([^/]+)/)?.[1] ?? "",
		);
		if (!slug || !sessionId)
			throw new Error("No project/session for Claude receipt");
		const db = new Database(harness.daemonStorePath(), { readonly: true });
		let contextWindow: string | null | undefined;
		try {
			contextWindow = db
				.prepare<[string, string], { context_window: string | null }>(
					`SELECT json_extract(payload_json, '$.contextWindow') AS context_window
				 FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'
				 AND json_extract(payload_json, '$.prompt') = ? ORDER BY request_sequence DESC LIMIT 1`,
				)
				.get(sessionId, prompt)?.context_window;
		} finally {
			db.close();
		}
		if (contextWindow == null)
			throw new Error("Claude command omitted contextWindow");
		// The bare SDK id covers both explicit 200k and the catalog default.
		// Read the dispatched window, and independently verify its SDK encoding.
		expect(apiModel).toBe(contextWindow === "1m" ? `${model}[1m]` : model);
		await test.info().attach("claude-turn-context.json", {
			body: JSON.stringify({ prompt, contextWindow, apiModel }),
			contentType: "application/json",
		});
		return {
			harness: "claude",
			provider: "claude",
			model,
			effort: enqueue.liveOptions.effort ?? "",
			contextWindow,
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
	stored?: ReturnType<typeof readStoredState>,
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
	if (stored) {
		const row = stored.pick;
		for (const [key, value] of [
			["harness", row?.provider],
			["provider", row?.model_provider],
			["model", row?.model_id],
			["effort", row?.variant],
			["contextWindow", row?.context_window],
		] as const) {
			if (shown[key] !== value)
				mismatches.push(
					`${key}: shown ${JSON.stringify(shown[key])}, stored ${JSON.stringify(value)}`,
				);
		}
	}
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
		...(stored ? { stored } : {}),
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
			permissionMode: "ask",
			projectSlug: draft.slug,
			originId: `${caseId}-setup`,
			instanceId: AccountIdSchema.make("claude"),
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
				const { picker, slug } = existing
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
				await openPickerRoot(page, picker);
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
				const stored = existing
					? readStoredState(
							harness,
							slug,
							decodeURIComponent(
								new URL(page.url()).pathname.split("/")[2] ?? "",
							),
						)
					: undefined;
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
					undefined,
					stored,
				);
			});
		}
	}
}

type RpcReply = { frame: RpcFrame; request: RpcFrame };
type RpcReceiptWindow = Window & {
	__pickGuardRpcReceipts?: Set<string>;
};

/** Hold real replies without blocking switches or changing their contents. */
async function observeSessionRpc(
	page: Page,
	editRequest?: (frame: RpcFrame) => RpcFrame,
	editReply?: (frame: RpcFrame, request: RpcFrame) => RpcFrame,
) {
	const requests: RpcFrame[] = [];
	const replies: RpcReply[] = [];
	const holds = new Map<
		string,
		{
			frames: RpcFrame[];
			arrived: () => void;
			gate: Promise<void>;
			once: boolean;
		}
	>();
	await editRpc(page, async (frame, request) => {
		if (frame._tag === "Request") requests.push(frame);
		const isReply =
			frame._tag === "Exit" ||
			(frame._tag === "Chunk" && request?.tag === "SubscribeDraftModels");
		if (isReply && request) {
			replies.push({ frame, request });
			const tag =
				request.tag === "SubscribeDraftModels" ? "GetModels" : request.tag;
			const hold = holds.get(`${tag}:${request.payload?.["sessionId"]}`);
			if (hold) {
				if (hold.once) holds.delete(`${tag}:${request.payload?.["sessionId"]}`);
				hold.frames.push(frame);
				hold.arrived();
				await hold.gate;
			}
		}
		return frame._tag === "Request"
			? (editRequest?.(frame) ?? frame)
			: isReply && request
				? (editReply?.(frame, request) ?? frame)
				: frame;
	});
	// Register after routeWebSocket's init script so its socket is observed too.
	await page.addInitScript(() => {
		const receipts = new Set<string>();
		(window as RpcReceiptWindow).__pickGuardRpcReceipts = receipts;
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				if (!new URL(this.url).pathname.endsWith("/rpc")) return;
				this.addEventListener("message", (event: MessageEvent<unknown>) => {
					if (typeof event.data !== "string") return;
					const frame = JSON.parse(event.data) as RpcFrame;
					if (
						(frame._tag === "Exit" || frame._tag === "Chunk") &&
						frame.requestId !== undefined
					)
						receipts.add(String(frame.requestId));
				});
			}
		};
	});
	return {
		requests,
		replies,
		async received(frames: readonly RpcFrame[]) {
			const requestIds = frames.map((frame) => {
				if (frame.requestId === undefined)
					throw new Error("Held RPC reply omitted requestId");
				return String(frame.requestId);
			});
			await page.waitForFunction(
				(ids) =>
					ids.every((id) =>
						(window as RpcReceiptWindow).__pickGuardRpcReceipts?.has(id),
					),
				requestIds,
			);
			return requestIds;
		},
		hold(tag: string, sessionId: string, options?: { once: boolean }) {
			const key = `${tag}:${sessionId}`;
			if (holds.has(key)) throw new Error(`A ${tag} reply is already held`);
			let arrived = () => {};
			let release = () => {};
			const wait = new Promise<void>((resolve) => {
				arrived = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const frames: RpcFrame[] = [];
			const held = { frames, arrived, gate, once: options?.once ?? false };
			holds.set(key, held);
			return {
				wait,
				frames,
				release() {
					if (holds.get(key) === held) holds.delete(key);
					release();
				},
			};
		},
	};
}

function shownFromGetModels(response: GetModelsResponse, driver: Driver): Pick {
	if (
		!response.instanceId ||
		!response.active ||
		!response.variant ||
		!response.contextWindow
	)
		throw new Error(
			"Session GetModels omitted its bound instance or stored pick",
		);
	return {
		harness: driver,
		provider: response.active.provider,
		model: response.active.model,
		effort: response.variant.variant ?? "",
		contextWindow: response.contextWindow.contextWindow,
	};
}

async function expectShown(picker: Locator, pick: Pick): Promise<void> {
	await expect(picker).toHaveAttribute("data-shown-harness", pick.harness);
	await expect(picker).toHaveAttribute("data-shown-provider", pick.provider);
	await expect(picker).toHaveAttribute("data-shown-model", pick.model);
	await expect(picker).toHaveAttribute("data-shown-effort", pick.effort);
	await expect(picker).toHaveAttribute(
		"data-shown-context-window",
		pick.contextWindow,
	);
}

async function openModelsSettings(page: Page): Promise<void> {
	// The title menu holds no Settings; a phone's island has its own overflow.
	await page
		.getByTestId("session-bar-overflow")
		.or(page.getByTestId("session-bar-island-overflow"))
		.click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-models").click();
}

async function createGuardSession(
	page: Page,
	harness: ProcessHarness,
	driver: Driver,
	caseId: string,
) {
	const draft = await openDraft(page, harness, driver);
	const { sessionId } = await Effect.runPromise(
		draft.browser.rpc.CreateSession({
			permissionMode: "ask",
			projectSlug: draft.slug,
			originId: `${caseId}-setup`,
			instanceId: AccountIdSchema.make(driver),
			model: {
				providerId: driver === "claude" ? "claude" : openCodeModel.providerID,
				modelId: driver === "claude" ? "sonnet" : openCodeModel.modelID,
				variant: driver === "claude" ? "low" : "",
				contextWindow: driver === "claude" ? "200k" : "",
			},
		}),
	);
	const url = `${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(draft.slug)}`;
	await new AppPage(page).goto(url);
	const reported = await Effect.runPromise(
		draft.browser.rpc.GetModels({ sessionId }),
	);
	await expectShown(draft.picker, shownFromGetModels(reported, driver));
	return { ...draft, sessionId, url, reported };
}

test.describe("session composer owns its stored pick", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: claudeModels,
			capabilityAgents: [
				{ id: "claude-guard-agent", name: "Claude guard agent" },
			],
			restartProof: true,
		},
	});

	for (const driver of ["claude", "opencode"] as const) {
		test(`composer-matches-getmodels: ${driver} after reload`, async ({
			page,
			harness,
		}, testInfo) => {
			const caseId = `composer-matches-getmodels-${driver}`;
			const observed = await observeSessionRpc(page);
			const { browser, slug, sessionId, picker } = await createGuardSession(
				page,
				harness,
				driver,
				caseId,
			);
			if (driver === "claude") await browser.startInstance("opencode");
			// The project default points at the other harness before hydration.
			await Effect.runPromise(
				browser.rpc.SetDefaultModel({
					projectSlug: slug,
					provider: driver === "claude" ? openCodeModel.providerID : "claude",
					model: driver === "claude" ? openCodeModel.modelID : "opus",
				}),
			);
			const beforeReload = observed.replies.length;
			let shown: Pick | undefined;
			let reported: GetModelsResponse | undefined;
			let delivered: GetModelsResponse | undefined;
			let sent: Pick | undefined;
			try {
				await page.reload();
				await expect
					.poll(
						() =>
							observed.replies
								.slice(beforeReload)
								.filter(
									({ request }) =>
										request.tag === "GetModels" &&
										request.payload?.["sessionId"] === sessionId,
								).length,
					)
					.toBeGreaterThan(0);
				const reply = observed.replies
					.slice(beforeReload)
					.find(
						({ request }) =>
							request.tag === "GetModels" &&
							request.payload?.["sessionId"] === sessionId,
					);
				delivered = Schema.decodeUnknownSync(GetModelsResponseSchema)(
					reply?.frame.exit?.value,
				);
				reported = await Effect.runPromise(
					browser.rpc.GetModels({ sessionId }),
				);
				await expectShown(picker, shownFromGetModels(delivered, driver));
				await expect(picker).toHaveAttribute(
					"data-instance-id",
					delivered.instanceId ?? "",
				);
				shown = await readShown(picker);
				expect(shown).toEqual(shownFromGetModels(reported, driver));
				expect(readStoredState(harness, slug, sessionId).pick).toMatchObject({
					provider: shown.harness,
					model_provider: shown.provider,
					model_id: shown.model,
					variant: shown.effort,
					context_window: shown.contextWindow,
				});
				sent = await sendAndCapture(page, harness, driver, `${caseId}-next`);
				expect(sent).toMatchObject({
					harness: shown.harness,
					provider: shown.provider,
					model: shown.model,
					effort: shown.effort,
				});
				if (driver === "claude")
					expect(sent.contextWindow).toBe(shown.contextWindow);
			} finally {
				await writeGuardArtifact(testInfo, {
					case: caseId,
					bead: "conduit-test-fmg0.5",
					sessionId,
					delivered,
					reported,
					shown,
					stored: readStoredState(harness, slug, sessionId),
					sent,
				});
			}
		});

		test(`composer-matches-getmodels-offline-${driver}: stored settings survive unavailable offers`, async ({
			page,
			harness,
		}, testInfo) => {
			const caseId = `composer-matches-getmodels-offline-${driver}`;
			const { browser, slug, sessionId, picker } = await createGuardSession(
				page,
				harness,
				driver,
				caseId,
			);
			await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId,
					variant: "high",
				}),
			);
			const reported = await Effect.runPromise(
				browser.rpc.GetModels({ sessionId }),
			);
			const intercepted: {
				request: RpcFrame;
				frame: RpcFrame;
				source: GetModelsResponse;
				delivered: GetModelsResponse;
			}[] = [];
			const observed = await observeSessionRpc(
				page,
				undefined,
				(frame, request) => {
					if (
						request.tag !== "GetModels" ||
						request.payload?.["sessionId"] !== sessionId ||
						frame.exit?._tag !== "Success"
					)
						return frame;
					const source = Schema.decodeUnknownSync(GetModelsResponseSchema)(
						frame.exit.value,
					);
					if (!source.variant || !source.contextWindow)
						throw new Error("Session reply omitted stored settings");
					const delivered: GetModelsResponse = {
						...source,
						providers: [],
						variant: { ...source.variant, variants: [] },
						contextWindow: { ...source.contextWindow, options: [] },
					};
					const edited = {
						...frame,
						exit: { ...frame.exit, value: delivered },
					};
					intercepted.push({ request, frame: edited, source, delivered });
					return edited;
				},
			);
			let stored = readStoredState(harness, slug, sessionId);
			let stage = "reload";
			let shown: Pick | undefined;
			let sent: Pick | undefined;
			let deliveredRequestIds: string[] = [];
			let effortControl:
				| { text: string | null; disabled: string | null }
				| undefined;
			let displayedContext: string | null | undefined;
			try {
				await page.reload();
				stage = "scoped GetModels arrival";
				await expect.poll(() => intercepted.length).toBeGreaterThan(0);
				const reply = intercepted[0];
				if (!reply)
					throw new Error("Reload did not deliver a scoped GetModels reply");
				stage = "scoped GetModels receipt";
				deliveredRequestIds = await observed.received(
					intercepted.map(({ frame }) => frame),
				);
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => resolve()),
							),
						),
				);
				stage = "displayed pick";
				shown = await readShown(picker);
				expect(reply.delivered.active).toEqual(reply.source.active);
				expect(reply.delivered.variant?.variant).toBe(
					reply.source.variant?.variant,
				);
				expect(reply.delivered.contextWindow?.contextWindow).toBe(
					reply.source.contextWindow?.contextWindow,
				);
				expect(reply.delivered.instanceId).toBe(reply.source.instanceId);
				expect(reply.delivered.variant?.variants).toEqual([]);
				expect(reply.delivered.contextWindow?.options).toEqual([]);
				await expectShown(picker, shownFromGetModels(reply.delivered, driver));
				await expect(picker).toHaveAttribute(
					"data-instance-id",
					reply.delivered.instanceId ?? "",
				);
				expect(shown).toEqual(shownFromGetModels(reported, driver));
				stored = readStoredState(harness, slug, sessionId);
				expect(stored.pick).toMatchObject({
					provider: shown.harness,
					model_provider: shown.provider,
					model_id: shown.model,
					variant: shown.effort,
					context_window: shown.contextWindow,
				});
				stage = "readonly settings";
				await openPickerRoot(page, picker);
				const effortRow = page.getByTestId("picker-row-effort");
				await expect(effortRow).toBeVisible();
				await expect(effortRow).toContainText(/high/i);
				await expect(effortRow).toHaveAttribute("aria-disabled", "true");
				await expect(
					effortRow.locator(
						'[role="radio"]:not(:disabled):not([aria-disabled="true"])',
					),
				).toHaveCount(0);
				effortControl = {
					text: await effortRow.textContent(),
					disabled: await effortRow.getAttribute("aria-disabled"),
				};
				if (driver === "claude") {
					const contextRow = page.getByTestId("picker-row-context");
					await expect(contextRow).toBeVisible();
					await expect(contextRow).toContainText(/200k/i);
					displayedContext = await contextRow.textContent();
				}
				await closePicker(page);
				stage = "next turn";
				sent = await sendAndCapture(page, harness, driver, `${caseId}-next`);
				stored = readStoredState(harness, slug, sessionId);
				expect(sent).toMatchObject({
					harness: shown.harness,
					provider: shown.provider,
					model: shown.model,
					effort: shown.effort,
				});
				if (driver === "claude")
					expect(sent.contextWindow).toBe(shown.contextWindow);
				stage = "complete";
			} finally {
				await writeGuardArtifact(testInfo, {
					case: caseId,
					bead: "conduit-test-fmg0.5",
					sessionId,
					stage,
					reported,
					intercepted,
					deliveredRequestIds,
					shown,
					effortControl,
					displayedContext,
					stored,
					sent,
				});
			}
		});

		for (const change of ["effort", "model", "context"] as const) {
			if (change === "context" && driver === "opencode") continue;
			test(`uvof: ${driver} ${change} beats an older GetModels reply`, async ({
				page,
				harness,
			}, testInfo) => {
				const caseId = `uvof-${driver}-${change}`;
				const observed = await observeSessionRpc(page);
				const { slug, sessionId, picker, reported } = await createGuardSession(
					page,
					harness,
					driver,
					caseId,
				);
				const held = observed.hold("GetModels", sessionId);
				const method =
					change === "effort"
						? "SwitchVariant"
						: change === "context"
							? "SwitchContextWindow"
							: "SwitchModel";
				const switchReply = observed.hold(method, sessionId);
				let optimistic: Pick | undefined;
				let shown: Pick | undefined;
				let sent: Pick | undefined;
				let deliveredRequestIds: string[] = [];
				let deliveredSwitchRequestIds: string[] = [];
				try {
					await openModelsSettings(page);
					await held.wait;
					await page.getByTestId("settings-close-btn").click();
					await openPickerRoot(page, picker);
					if (change === "effort")
						await page.getByTestId("picker-effort-option-high").click();
					else if (change === "context")
						await page.getByTestId("picker-context-option-1m").click();
					else {
						await page.getByTestId("picker-row-model").click();
						await page
							.getByTestId("model-picker-list")
							.locator(
								driver === "claude"
									? '[data-model-id="opus"][data-provider-id="claude"]'
									: `[data-model-id="${otherOpenCodeModel.modelID}"][data-provider-id="${otherOpenCodeModel.providerID}"]`,
							)
							.click();
					}
					const attribute = change === "context" ? "context-window" : change;
					const chosen =
						change === "effort"
							? "high"
							: change === "context"
								? "1m"
								: driver === "claude"
									? "opus"
									: otherOpenCodeModel.modelID;
					await switchReply.wait;
					await expect(picker).toHaveAttribute(
						`data-shown-${attribute}`,
						chosen,
					);
					optimistic = await readShown(picker);
					switchReply.release();
					deliveredSwitchRequestIds = await observed.received(
						switchReply.frames,
					);
					const stale = Schema.decodeUnknownSync(GetModelsResponseSchema)(
						held.frames[0]?.exit?.value,
					);
					expect(shownFromGetModels(stale, driver)).toEqual(
						shownFromGetModels(reported, driver),
					);
					held.release();
					deliveredRequestIds = await observed.received(held.frames);
					await closePicker(page);
					// Let the delivered socket reply and Svelte render settle before reading.
					await page.evaluate(
						() =>
							new Promise<void>((resolve) =>
								requestAnimationFrame(() =>
									requestAnimationFrame(() => resolve()),
								),
							),
					);
					await expect(picker).toHaveAttribute(
						`data-shown-${attribute}`,
						chosen,
					);
					shown = await readShown(picker);
					expect(readStoredState(harness, slug, sessionId).pick).toMatchObject({
						model_id: shown.model,
						model_provider: shown.provider,
						variant: shown.effort,
						context_window: shown.contextWindow,
					});
					sent = await sendAndCapture(page, harness, driver, `${caseId}-next`);
					expect(sent).toMatchObject({
						harness: shown.harness,
						provider: shown.provider,
						model: shown.model,
						effort: shown.effort,
					});
					if (driver === "claude")
						expect(sent.contextWindow).toBe(shown.contextWindow);
				} finally {
					held.release();
					switchReply.release();
					await writeGuardArtifact(testInfo, {
						case: caseId,
						bead: "conduit-test-uvof",
						sessionId,
						before: reported,
						staleReplies: held.frames,
						deliveredRequestIds,
						switchReplies: switchReply.frames,
						deliveredSwitchRequestIds,
						optimisticWhileReplyHeld: optimistic !== undefined,
						optimistic,
						shown,
						stored: readStoredState(harness, slug, sessionId),
						sent,
					});
				}
			});
		}
	}

	test("row-read-session-isolation: A's delayed row reply keeps B's permission mode", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "row-read-session-isolation";
		const observed = await observeSessionRpc(page);
		const {
			browser,
			slug,
			sessionId: sessionA,
			picker,
		} = await createGuardSession(page, harness, "claude", caseId);
		await Effect.runPromise(
			browser.rpc.SwitchPermissionMode({
				sessionId: sessionA,
				mode: "ask",
			}),
		);
		const { sessionId: sessionB } = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug: slug,
				originId: `${caseId}-B`,
				instanceId: AccountIdSchema.make("claude"),
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "low",
					contextWindow: "200k",
				},
			}),
		);
		await Effect.runPromise(
			browser.rpc.SwitchPermissionMode({
				sessionId: sessionB,
				mode: "full",
			}),
		);
		const reportedB = await Effect.runPromise(
			browser.rpc.GetModels({ sessionId: sessionB }),
		);
		const mode = page.locator(
			'[data-testid="permission-mode-badge"]:visible, [data-testid="composer-word-approvals"]:visible, [data-testid="composer-more-mode"]:visible',
		);
		const phoneWords = page.getByTestId("composer-words-sheet-trigger");
		let openedComposer = false;
		const older = observed.hold("GetModels", sessionA, { once: true });
		let stage = "A-row-read";
		let before: string | null | undefined;
		let after: string | null | undefined;
		let shown: Pick | undefined;
		let deliveredRequestIds: string[] = [];
		try {
			await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId: sessionA,
					variant: "high",
				}),
			);
			await older.wait;
			const reportedA = Schema.decodeUnknownSync(GetModelsResponseSchema)(
				older.frames[0]?.exit?.value,
			);
			expect(reportedA.permissionMode).toBe("ask");
			expect(reportedA.variant?.variant).toBe("high");
			expect(reportedB.permissionMode).toBe("full");
			stage = "B-current";
			if (!(await page.locator("#new-session-btn:visible").isVisible()))
				await page.getByTestId("session-bar-back").click();
			await page
				.locator(
					`#session-list [data-session-id="${sessionB}"] .session-item-title`,
				)
				.click();
			await expect(page).toHaveURL(new RegExp(`/s/${sessionB}\\?`));
			await expectShown(picker, shownFromGetModels(reportedB, "claude"));
			await expect(picker).toHaveAttribute(
				"data-shown-permission-mode",
				"full",
			);
			before = await picker.getAttribute("data-shown-permission-mode");
			if (await phoneWords.isVisible())
				await expect(
					phoneWords.getByText("full", { exact: true }),
				).toBeVisible();
			if (!(await mode.isVisible())) {
				await picker.click();
				openedComposer = true;
			}
			await expect(mode).toHaveAccessibleName(
				"Approvals: Full access. Open options",
			);
			stage = "A-stale-delivered";
			older.release();
			deliveredRequestIds = await observed.received(older.frames);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			after = await picker.getAttribute("data-shown-permission-mode");
			await expect(mode).toHaveAccessibleName(
				"Approvals: Full access. Open options",
			);
			if (openedComposer) await page.keyboard.press("Escape");
			if (await phoneWords.isVisible())
				await expect(
					phoneWords.getByText("full", { exact: true }),
				).toBeVisible();
			shown = await readShown(picker);
			expect(after).toBe(before);
			expect(shown).toEqual(shownFromGetModels(reportedB, "claude"));
			stage = "complete";
		} finally {
			older.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.5",
				stage,
				sessions: { sessionA, sessionB },
				reportedB,
				heldRowReplies: older.frames,
				deliveredRequestIds,
				permissionMode: { before, after },
				shown,
			});
		}
	});

	test("row-read-ordering: a newer row reply beats an older reply delivered last", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "row-read-ordering";
		const observed = await observeSessionRpc(page);
		const { browser, slug, sessionId, picker } = await createGuardSession(
			page,
			harness,
			"claude",
			caseId,
		);
		const older = observed.hold("GetModels", sessionId, { once: true });
		let newer: ReturnType<typeof observed.hold> | undefined;
		let stage = "older-row-read";
		let shown: Pick | undefined;
		let stored: ReturnType<typeof readStoredState> | undefined;
		let sent: Pick | undefined;
		const delivered: { read: string; requestIds: string[] }[] = [];
		try {
			await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId,
					variant: "high",
				}),
			);
			await older.wait;
			expect(
				Schema.decodeUnknownSync(GetModelsResponseSchema)(
					older.frames[0]?.exit?.value,
				).variant?.variant,
			).toBe("high");
			stage = "newer-row-read";
			newer = observed.hold("GetModels", sessionId, { once: true });
			await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId,
					variant: "low",
				}),
			);
			await newer.wait;
			const reported = Schema.decodeUnknownSync(GetModelsResponseSchema)(
				newer.frames[0]?.exit?.value,
			);
			expect(reported.variant?.variant).toBe("low");
			newer.release();
			delivered.push({
				read: "newer",
				requestIds: await observed.received(newer.frames),
			});
			await expectShown(picker, shownFromGetModels(reported, "claude"));
			stage = "older-delivered-last";
			older.release();
			delivered.push({
				read: "older",
				requestIds: await observed.received(older.frames),
			});
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			shown = await readShown(picker);
			stored = readStoredState(harness, slug, sessionId);
			stage = "next-turn";
			sent = await sendAndCapture(page, harness, "claude", `${caseId}-next`);
			expect(shown).toEqual(shownFromGetModels(reported, "claude"));
			expect(stored.pick).toMatchObject({ variant: shown.effort });
			expect(sent).toEqual(shown);
			stage = "complete";
		} finally {
			older.release();
			newer?.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.5",
				stage,
				sessionId,
				olderReplies: older.frames,
				newerReplies: newer?.frames,
				delivered,
				shown,
				stored,
				sent,
			});
		}
	});

	test("rejection-refresh: a rejected click reloads the stored pick after a held row read", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "rejection-refresh";
		let rejectedSessionId = "";
		const refusedRequests: RpcFrame[] = [];
		const observed = await observeSessionRpc(page, (frame) => {
			if (
				frame.tag !== "SwitchVariant" ||
				frame.payload?.["sessionId"] !== rejectedSessionId ||
				frame.payload?.["variant"] !== "high"
			)
				return frame;
			const refused = {
				...frame,
				payload: { ...frame.payload, variant: "not-offered-refresh" },
			};
			refusedRequests.push(refused);
			return refused;
		});
		const { browser, slug, sessionId, picker, reported } =
			await createGuardSession(page, harness, "claude", caseId);
		rejectedSessionId = sessionId;
		const rowRead = observed.hold("GetModels", sessionId, { once: true });
		const rejection = observed.hold("SwitchVariant", sessionId, { once: true });
		let stage = "stored-pick-changed";
		let optimistic: Pick | undefined;
		let shown: Pick | undefined;
		let stored: ReturnType<typeof readStoredState> | undefined;
		let sent: Pick | undefined;
		let freshReply: GetModelsResponse | undefined;
		let deliveredReadRequestIds: string[] = [];
		let deliveredRejectionRequestIds: string[] = [];
		let requestsAfterRejection: RpcFrame[] = [];
		try {
			await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId,
					variant: "high",
				}),
			);
			await rowRead.wait;
			const currentStored = Schema.decodeUnknownSync(GetModelsResponseSchema)(
				rowRead.frames[0]?.exit?.value,
			);
			expect(reported.variant?.variant).toBe("low");
			expect(currentStored.variant?.variant).toBe("high");
			stored = readStoredState(harness, slug, sessionId);
			stage = "rejected-click-held";
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-effort-option-high").click();
			await rejection.wait;
			expect(rejection.frames[0]?.exit?._tag).toBe("Failure");
			await expect(picker).toHaveAttribute("data-shown-effort", "high");
			optimistic = await readShown(picker);
			rowRead.release();
			deliveredReadRequestIds = await observed.received(rowRead.frames);
			stage = "rejection-delivered";
			const beforeRejection = observed.requests.length;
			rejection.release();
			deliveredRejectionRequestIds = await observed.received(rejection.frames);
			await expect(
				page.getByText('Couldn\'t switch thinking level to "high"', {
					exact: true,
				}),
			).toBeVisible();
			shown = await readShown(picker);
			requestsAfterRejection = observed.requests.slice(beforeRejection);
			await expectShown(picker, shownFromGetModels(currentStored, "claude"));
			await expect
				.poll(
					() =>
						observed.replies.filter(
							({ request }) =>
								request.tag === "GetModels" &&
								request.payload?.["sessionId"] === sessionId &&
								observed.requests.indexOf(request) >= beforeRejection,
						).length,
				)
				.toBeGreaterThan(0);
			requestsAfterRejection = observed.requests.slice(beforeRejection);
			const refresh = observed.replies.find(
				({ request }) =>
					request.tag === "GetModels" &&
					request.payload?.["sessionId"] === sessionId &&
					observed.requests.indexOf(request) >= beforeRejection,
			);
			freshReply = Schema.decodeUnknownSync(GetModelsResponseSchema)(
				refresh?.frame.exit?.value,
			);
			expect(freshReply.variant?.variant).toBe("high");
			await closePicker(page);
			stage = "next-turn";
			sent = await sendAndCapture(page, harness, "claude", `${caseId}-next`);
			expect(sent).toEqual(shown);
			expect(stored.pick).toMatchObject({ variant: shown.effort });
			stage = "complete";
		} finally {
			rowRead.release();
			rejection.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.5",
				stage,
				sessionId,
				before: reported,
				rowReadReplies: rowRead.frames,
				refusedRequests,
				rejectionReplies: rejection.frames,
				deliveredReadRequestIds,
				deliveredRejectionRequestIds,
				requestsAfterRejection,
				freshReply,
				optimistic,
				shown,
				stored,
				sent,
			});
		}
	});

	test("overlap-rollback: model success survives a newer effort rejection", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "overlap-rollback";
		const refusedRequests: RpcFrame[] = [];
		let rejectionSessionId = "";
		const observed = await observeSessionRpc(page, (frame) => {
			if (
				frame.tag !== "SwitchVariant" ||
				frame.payload?.["sessionId"] !== rejectionSessionId ||
				frame.payload?.["variant"] !== "max"
			)
				return frame;
			// The daemon refuses this request without persisting the optimistic max.
			const refused = {
				...frame,
				payload: { ...frame.payload, variant: "not-offered-overlap" },
			};
			refusedRequests.push(refused);
			return refused;
		});
		const { browser, slug, sessionId, picker, reported } =
			await createGuardSession(page, harness, "claude", caseId);
		rejectionSessionId = sessionId;
		const reads = observed.hold("GetModels", sessionId);
		const modelReply = observed.hold("SwitchModel", sessionId);
		const effortReply = observed.hold("SwitchVariant", sessionId);
		const snapshots: { step: string; shown: Pick }[] = [];
		let successfulModel: ReturnType<typeof readStoredState> | undefined;
		let reportedAfterModel: GetModelsResponse | undefined;
		let shown: Pick | undefined;
		let sent: Pick | undefined;
		let deliveredModelRequestIds: string[] = [];
		let deliveredEffortRequestIds: string[] = [];
		try {
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-row-model").click();
			await page
				.getByTestId("model-picker-list")
				.locator('[data-model-id="opus"][data-provider-id="claude"]')
				.click();
			await modelReply.wait;
			await expect(picker).toHaveAttribute("data-shown-model", "opus");
			expect(modelReply.frames[0]?.exit?._tag).toBe("Success");
			successfulModel = readStoredState(harness, slug, sessionId);
			reportedAfterModel = await Effect.runPromise(
				browser.rpc.GetModels({ sessionId }),
			);
			expect(reported.variant?.variant).toBe("low");
			expect(reportedAfterModel.variant?.variant).toBe("");
			snapshots.push({
				step: "model-success-held",
				shown: await readShown(picker),
			});

			await page.getByTestId("picker-effort-option-max").click();
			await effortReply.wait;
			await expect(picker).toHaveAttribute("data-shown-effort", "max");
			expect(effortReply.frames[0]?.exit?._tag).toBe("Failure");
			snapshots.push({
				step: "effort-rejection-held",
				shown: await readShown(picker),
			});

			modelReply.release();
			deliveredModelRequestIds = await observed.received(modelReply.frames);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			await expect(picker).toHaveAttribute("data-shown-effort", "max");
			snapshots.push({
				step: "model-success-delivered",
				shown: await readShown(picker),
			});

			effortReply.release();
			deliveredEffortRequestIds = await observed.received(effortReply.frames);
			await expect(
				page.getByText('Couldn\'t switch thinking level to "max"', {
					exact: true,
				}),
			).toBeVisible();
			await expectShown(
				picker,
				shownFromGetModels(reportedAfterModel, "claude"),
			);
			shown = await readShown(picker);
			snapshots.push({ step: "effort-reverted", shown });
			const reverted = readStoredState(harness, slug, sessionId);
			expect(reverted.pick).toEqual(successfulModel.pick);
			expect(reverted.pickEvents).toEqual(successfulModel.pickEvents);
			await closePicker(page);
			sent = await sendAndCapture(page, harness, "claude", `${caseId}-next`);
			expect(sent).toEqual(shown);
		} finally {
			reads.release();
			modelReply.release();
			effortReply.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.5",
				sessionId,
				before: reported,
				successfulModel,
				reportedAfterModel,
				heldReads: reads.frames,
				refusedRequests,
				modelReplies: modelReply.frames,
				effortReplies: effortReply.frames,
				deliveredModelRequestIds,
				deliveredEffortRequestIds,
				snapshots,
				shown,
				stored: readStoredState(harness, slug, sessionId),
				sent,
			});
		}
	});

	test("session-pick-isolation: Claude, draft, OpenCode, draft, Claude", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "session-pick-isolation";
		const observed = await observeSessionRpc(page);
		const {
			browser,
			slug,
			sessionId: claudeId,
			picker,
			reported: claudePick,
		} = await createGuardSession(page, harness, "claude", caseId);
		await browser.startInstance("opencode");
		const { sessionId: openCodeId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug: slug,
				originId: `${caseId}-opencode`,
				instanceId: AccountIdSchema.make("opencode"),
				model: {
					providerId: openCodeModel.providerID,
					modelId: openCodeModel.modelID,
					variant: "high",
					contextWindow: "",
				},
			}),
		);
		const openCodePick = await Effect.runPromise(
			browser.rpc.GetModels({ sessionId: openCodeId }),
		);
		const snapshots: { step: string; shown: Pick }[] = [];
		let deliveredRequestIds: string[] = [];
		const held = observed.hold("GetModels", openCodeId);
		async function showList() {
			if (!(await page.locator("#new-session-btn:visible").isVisible()))
				await page.getByTestId("session-bar-back").click();
		}
		async function showDraft(step: string) {
			await showList();
			await page.locator("#new-session-btn:visible").click();
			await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
			await expect(picker).toHaveAttribute("data-shown-model", /.+/);
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-harness-claude").click();
			await closePicker(page);
			await pickModel(page, picker, { providerID: "claude", modelID: "opus" });
			snapshots.push({ step, shown: await readShown(picker) });
		}
		async function showSession(sessionId: string) {
			await showList();
			await page
				.locator(
					`#session-list [data-session-id="${sessionId}"] .session-item-title`,
				)
				.click();
			await expect(page).toHaveURL(new RegExp(`/s/${sessionId}\\?`));
		}
		try {
			snapshots.push({ step: "claude-before", shown: await readShown(picker) });
			await showDraft("draft-between");
			await showSession(openCodeId);
			await held.wait;
			// Until its stored pick replies, a session shows no harness (ksw2),
			// and never the draft's Claude pick; only its bound account.
			await expectShown(picker, {
				harness: "",
				provider: "",
				model: "",
				effort: "",
				contextWindow: "",
			});
			await expect(picker).toHaveAttribute("data-instance-id", "opencode");
			snapshots.push({
				step: "opencode-loading",
				shown: await readShown(picker),
			});
			held.release();
			deliveredRequestIds = await observed.received(held.frames);
			await expectShown(picker, shownFromGetModels(openCodePick, "opencode"));
			snapshots.push({
				step: "opencode-loaded",
				shown: await readShown(picker),
			});
			await showDraft("draft-after-opencode");
			await showSession(claudeId);
			await expectShown(picker, shownFromGetModels(claudePick, "claude"));
			snapshots.push({ step: "claude-after", shown: await readShown(picker) });
			expect(snapshots.at(-1)?.shown).toEqual(snapshots[0]?.shown);
		} finally {
			held.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.5",
				sessions: { claudeId, openCodeId },
				reported: { claude: claudePick, opencode: openCodePick },
				deliveredRequestIds,
				snapshots,
				stored: {
					claude: readStoredState(harness, slug, claudeId),
					opencode: readStoredState(harness, slug, openCodeId),
				},
			});
		}
	});

	for (const driver of ["claude", "opencode"] as const) {
		test(`3rdi: ${driver} session agents with the other project default`, async ({
			page,
			harness,
		}, testInfo) => {
			const caseId = `3rdi-${driver}`;
			const observed = await observeSessionRpc(page);
			const { browser, slug, picker } = await openDraft(page, harness, driver);
			if (driver === "claude") await browser.startInstance("opencode");
			const { sessionId } = await Effect.runPromise(
				browser.rpc.CreateSession({
					permissionMode: "ask",
					projectSlug: slug,
					originId: `${caseId}-setup`,
					instanceId: AccountIdSchema.make(driver),
					model: {
						providerId:
							driver === "claude" ? "claude" : openCodeModel.providerID,
						modelId: driver === "claude" ? "sonnet" : openCodeModel.modelID,
						variant: "high",
						contextWindow: driver === "claude" ? "200k" : "",
					},
				}),
			);
			await Effect.runPromise(
				browser.rpc.SetDefaultModel({
					projectSlug: slug,
					provider: driver === "claude" ? openCodeModel.providerID : "claude",
					model: driver === "claude" ? openCodeModel.modelID : "sonnet",
				}),
			);
			const reported = await Effect.runPromise(
				browser.rpc.GetAgents({ sessionId }),
			);
			const projectDefault = await Effect.runPromise(
				browser.rpc.GetAgents({ projectSlug: slug }),
			);
			const held = observed.hold("GetAgents", sessionId);
			let settingsRequests: RpcFrame[] = [];
			let displayed: string[] = [];
			let deliveredRequestIds: string[] = [];
			try {
				await new AppPage(page).goto(
					`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(slug)}`,
				);
				await expect(picker).toHaveAttribute("data-shown-harness", driver);
				await held.wait;
				const requestsBefore = observed.requests.length;
				// Keep the initial agents read in flight so this tab must fetch agents.
				await openModelsSettings(page);
				await expect
					.poll(
						() =>
							observed.requests
								.slice(requestsBefore)
								.filter((request) => request.tag === "GetAgents").length,
					)
					.toBeGreaterThan(0);
				settingsRequests = observed.requests
					.slice(requestsBefore)
					.filter((request) => request.tag === "GetAgents");
				expect(
					settingsRequests.map((request) => request.payload?.["sessionId"]),
				).toEqual([sessionId]);
				await expect
					.poll(() =>
						observed.replies.some(
							({ request }) => request.id === settingsRequests[0]?.id,
						),
					)
					.toBe(true);
				// The newly scoped settings read and the original read can both finish.
				held.release();
				deliveredRequestIds = await observed.received(held.frames);
				const agents = page.getByTestId("settings-agents-group");
				await expect(agents).toContainText(
					`${reported.providerScope.name} agents`,
				);
				await agents
					.getByRole("button", {
						name: new RegExp(`${reported.providerScope.name} agents`),
					})
					.click();
				const expectedAgents = reported.agents.map(
					(agent) => agent.name || agent.id,
				);
				await expect(agents.getByRole("switch")).toHaveText(expectedAgents);
				displayed = await agents.getByRole("switch").allTextContents();
				expect(reported.providerScope.id).toBe(driver);
				expect(reported.providerScope.id).not.toBe(
					projectDefault.providerScope.id,
				);
				const reply = observed.replies.find(
					({ request }) =>
						request.tag === "GetAgents" &&
						request.id === settingsRequests[0]?.id,
				);
				expect(
					Schema.decodeUnknownSync(GetAgentsResponseSchema)(
						reply?.frame.exit?.value,
					),
				).toEqual(reported);
			} finally {
				held.release();
				await writeGuardArtifact(testInfo, {
					case: caseId,
					bead: "conduit-test-3rdi",
					sessionId,
					reported,
					projectDefault,
					settingsRequests,
					displayed,
					initialReplies: held.frames,
					deliveredRequestIds,
				});
			}
		});
	}
});

type DraftPick = Pick & { instanceId: string; permissionMode: string };
type DraftCreatePayload = {
	instanceId?: string;
	model?: {
		providerId?: string;
		modelId?: string;
		variant?: string;
		contextWindow?: string;
	};
	permissionMode?: string;
};
type DraftSocketWindow = Window & { __draftGuardSockets?: WebSocket[] };

async function observeDraftSockets(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const sockets: WebSocket[] = [];
		(window as DraftSocketWindow).__draftGuardSockets = sockets;
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				sockets.push(this);
			}
		};
	});
}

async function reconnectDraft(page: Page): Promise<void> {
	const before = await page.evaluate(() => {
		const sockets = (window as DraftSocketWindow).__draftGuardSockets ?? [];
		const count = sockets.length;
		for (const socket of sockets)
			if (socket.readyState === WebSocket.OPEN)
				socket.close(4001, "draft pick reconnect guard");
		return count;
	});
	await page.waitForFunction((count) => {
		const sockets = (window as DraftSocketWindow).__draftGuardSockets ?? [];
		return (
			sockets.length > count &&
			sockets
				.slice(count)
				.some((socket) => socket.readyState === WebSocket.OPEN)
		);
	}, before);
}

async function selectDraftHarness(
	page: Page,
	picker: Locator,
	driver: Driver,
): Promise<void> {
	await openPickerRoot(page, picker);
	await page.getByTestId(`picker-harness-${driver}`).click();
	await closePicker(page);
	await expect(picker).toHaveAttribute("data-instance-id", driver);
}

async function selectFullPermission(page: Page): Promise<void> {
	const trigger = page.locator(
		'[data-testid="permission-mode-badge"]:visible, [data-testid="composer-word-approvals"]:visible',
	);
	if (await trigger.count()) {
		await trigger.click();
	} else {
		await page.locator(pickerSelector).click();
		await page.getByTestId("composer-more-mode").click();
	}
	await page.getByTestId("permission-mode-option-full").click();
	await expect(
		page.getByRole("button", {
			name: "Approvals: Full access. Open options",
			exact: true,
		}),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator(pickerSelector)).toHaveAttribute(
		"data-shown-permission-mode",
		"full",
	);
}

function readDraftReceipt(
	harness: ProcessHarness,
	slug: string,
	sessionId: string,
) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const stored = db
			.prepare<
				[string, string],
				StoredPickRow & { permission_mode: string | null }
			>(
				`SELECT provider, model_id, model_provider, variant, context_window, permission_mode
			 FROM sessions WHERE id = ? AND project_id = ?`,
			)
			.get(sessionId, slug);
		const row = db
			.prepare<[string], { payload_json: string }>(
				`SELECT payload_json FROM provider_command_outbox WHERE session_id = ?
			 AND effect_type = 'send_turn' ORDER BY request_sequence LIMIT 1`,
			)
			.get(sessionId);
		if (!stored || !row)
			throw new Error("Draft send omitted its stored pick or provider command");
		return {
			stored,
			command: JSON.parse(row.payload_json) as DraftCreatePayload & {
				variant?: string;
				contextWindow?: string;
			},
		};
	} finally {
		db.close();
	}
}

async function assertDraftReceipt(
	page: Page,
	harness: ProcessHarness,
	setup: { browser: ProcessBrowser; slug: string; picker: Locator },
	driver: Driver,
	caseId: string,
	observed: Awaited<ReturnType<typeof observeSessionRpc>>,
	testInfo: TestInfo,
	permissionMode = "ask",
) {
	const shown: DraftPick = {
		...(await readShown(setup.picker)),
		instanceId: (await setup.picker.getAttribute("data-instance-id")) ?? "",
		permissionMode:
			(await setup.picker.getAttribute("data-shown-permission-mode")) ?? "",
	};
	expect(shown.permissionMode).toBe(permissionMode);
	const sent = await sendAndCapture(page, harness, driver, `${caseId}-first`);
	const sessionId = decodeURIComponent(
		new URL(page.url()).pathname.match(/\/s\/([^/]+)/)?.[1] ?? "",
	);
	const reported = await Effect.runPromise(
		setup.browser.rpc.GetModels({ sessionId }),
	);
	const receipt = readDraftReceipt(harness, setup.slug, sessionId);
	const sentPick: DraftPick = {
		...sent,
		instanceId: receipt.command.instanceId ?? "",
		contextWindow: receipt.command.contextWindow ?? "",
		permissionMode: receipt.command.permissionMode ?? "",
	};
	const creates = observed.requests.filter(
		(request) => request.tag === "CreateSession",
	);
	const created = creates[0]?.payload as DraftCreatePayload | undefined;
	const expectedPayload = {
		instanceId: shown.instanceId,
		model: {
			providerId: shown.provider,
			modelId: shown.model,
			variant: shown.effort,
			contextWindow: shown.contextWindow,
		},
		permissionMode: shown.permissionMode,
	};
	const providerReceipt =
		driver === "claude"
			? enqueues(harness, false).filter(
					(mark) => mark.prompt === `${caseId}-first`,
				)
			: openCodePrompts(harness);
	const sessionlessSwitches = observed.requests.filter(
		(request) =>
			[
				"SwitchModel",
				"SwitchVariant",
				"SwitchContextWindow",
				"SwitchPermissionMode",
			].includes(request.tag ?? "") && !request.payload?.["sessionId"],
	);
	await writeGuardArtifact(testInfo, {
		case: caseId,
		bead: "conduit-test-fmg0.6",
		shown,
		created,
		stored: receipt.stored,
		reported,
		sent: sentPick,
		providerReceipt,
		command: receipt.command,
		sessionlessSwitches,
	});
	expect(creates).toHaveLength(1);
	expect(sentPick).toEqual(shown);
	expect(created).toMatchObject(expectedPayload);
	expect(shownFromGetModels(reported, driver)).toEqual({
		harness: shown.harness,
		provider: shown.provider,
		model: shown.model,
		effort: shown.effort,
		contextWindow: shown.contextWindow,
	});
	expect(reported.permissionMode).toBe(shown.permissionMode);
	expect(receipt.stored).toEqual({
		provider: shown.instanceId,
		model_provider: shown.provider,
		model_id: shown.model,
		variant: shown.effort,
		context_window: shown.contextWindow,
		permission_mode: shown.permissionMode,
	});
	expect(receipt.command).toMatchObject({
		instanceId: shown.instanceId,
		model: { providerId: shown.provider, modelId: shown.model },
		variant: shown.effort,
		contextWindow: shown.contextWindow,
		permissionMode: shown.permissionMode,
	});
	expect(sent).toMatchObject({
		harness: shown.harness,
		provider: shown.provider,
		model: shown.model,
		effort: shown.effort,
	});
	if (driver === "claude") {
		expect(sent.contextWindow).toBe(shown.contextWindow);
		const enqueue = enqueues(harness, false).find(
			(mark) => mark.prompt === `${caseId}-first`,
		);
		expect(enqueue?.liveOptions.permissionMode).toBe(
			permissionMode === "full" ? "bypassPermissions" : "default",
		);
	}
	expect(sessionlessSwitches).toEqual([]);
	expect(
		observed.requests.filter(
			(request) => request.tag === "SwitchPermissionMode",
		),
	).toEqual([]);
	return { shown, reported, receipt, created, sent: sentPick };
}

test.describe("draft owns one complete pick", () => {
	test.use({
		harnessOptions: {
			opencodeRecording: "chat-simple",
			capabilityModels: claudeModels,
			capabilityAgents: [
				{ id: "claude-draft-agent", name: "Claude draft agent" },
			],
			restartProof: true,
		},
	});

	for (const driver of ["claude", "opencode"] as const) {
		test(`draft-first-send-${driver}: displayed model effort context and permission are stored and sent`, async ({
			page,
			harness,
		}, testInfo) => {
			const observed = await observeSessionRpc(page);
			const draft = await openDraft(
				page,
				harness,
				driver,
				async (browser, slug) => {
					await Effect.runPromise(
						browser.rpc.SetDefaultPermissionMode({
							projectSlug: slug,
							mode: "ask",
						}),
					);
				},
			);
			await openPickerRoot(page, draft.picker);
			await page.getByTestId("picker-effort-option-high").click();
			if (driver === "claude")
				await page.getByTestId("picker-context-option-1m").click();
			else
				await expect(
					page.locator('[data-testid^="picker-context-option-"]:visible'),
				).toHaveCount(0);
			await closePicker(page);
			await expect(draft.picker).toHaveAttribute("data-shown-effort", "high");
			await expect(draft.picker).toHaveAttribute(
				"data-shown-context-window",
				driver === "claude" ? "1m" : "",
			);
			await selectFullPermission(page);
			await assertDraftReceipt(
				page,
				harness,
				draft,
				driver,
				`draft-first-send-${driver}`,
				observed,
				testInfo,
				"full",
			);
		});
	}

	test("draft-model-memory: effort and context are remembered per model and harness", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const draft = await openDraft(
			page,
			harness,
			"claude",
			async (browser, slug) => {
				await browser.startInstance("opencode");
				await Effect.runPromise(
					browser.rpc.SetHarnessDefault({
						projectSlug: slug,
						harness: "claude",
						providerId: "claude",
						modelId: "opus",
						effort: "high",
						contextWindow: "1m",
					}),
				);
			},
		);
		const snapshots: { step: string; shown: Pick }[] = [];
		await pickModel(page, draft.picker, {
			providerID: "claude",
			modelID: "opus",
		});
		await openPickerRoot(page, draft.picker);
		await page.getByTestId("picker-effort-option-max").click();
		await page.getByTestId("picker-context-option-200k").click();
		await closePicker(page);
		snapshots.push({
			step: "opus-saved",
			shown: await readShown(draft.picker),
		});
		await pickModel(page, draft.picker, {
			providerID: "claude",
			modelID: "sonnet",
		});
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "");
		await openPickerRoot(page, draft.picker);
		await expect(
			page.locator('[data-testid^="picker-effort-option-"]:visible'),
		).toHaveText(["low", "high"]);
		await closePicker(page);
		snapshots.push({
			step: "unsupported-effort-reset",
			shown: await readShown(draft.picker),
		});
		await pickModel(page, draft.picker, {
			providerID: "claude",
			modelID: "opus",
		});
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "max");
		await expect(draft.picker).toHaveAttribute(
			"data-shown-context-window",
			"200k",
		);
		snapshots.push({
			step: "opus-restored",
			shown: await readShown(draft.picker),
		});
		await selectDraftHarness(page, draft.picker, "opencode");
		await pickModel(page, draft.picker, openCodeModel);
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "");
		await openPickerRoot(page, draft.picker);
		await page.getByTestId("picker-effort-option-medium").click();
		await closePicker(page);
		await pickModel(page, draft.picker, otherOpenCodeModel);
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "");
		await pickModel(page, draft.picker, openCodeModel);
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "medium");
		snapshots.push({
			step: "opencode-restored",
			shown: await readShown(draft.picker),
		});
		await selectDraftHarness(page, draft.picker, "claude");
		await pickModel(page, draft.picker, {
			providerID: "claude",
			modelID: "opus",
		});
		await expect(draft.picker).toHaveAttribute("data-shown-effort", "max");
		await expect(draft.picker).toHaveAttribute(
			"data-shown-context-window",
			"200k",
		);
		snapshots.push({
			step: "claude-memory-isolated",
			shown: await readShown(draft.picker),
		});
		const proof = await assertDraftReceipt(
			page,
			harness,
			draft,
			"claude",
			"draft-model-memory",
			observed,
			testInfo,
		);
		await writeGuardArtifact(testInfo, {
			case: "draft-model-memory",
			bead: "conduit-test-fmg0.6",
			...proof,
			snapshots,
			requests: observed.requests.filter((request) =>
				/^Switch/.test(request.tag ?? ""),
			),
		});
		expect(
			observed.requests.filter((request) => /^Switch/.test(request.tag ?? "")),
		).toEqual([]);
	});

	for (const driver of ["claude", "opencode"] as const) {
		test(`mdpt-${driver}: a websocket reconnect preserves the held draft pick`, async ({
			page,
			harness,
		}, testInfo) => {
			const observed = await observeSessionRpc(page);
			await observeDraftSockets(page);
			const draft = await openDraft(page, harness, driver);
			await pickModel(
				page,
				draft.picker,
				driver === "claude"
					? { providerID: "claude", modelID: "opus" }
					: otherOpenCodeModel,
			);
			await openPickerRoot(page, draft.picker);
			await page.getByTestId("picker-effort-option-high").click();
			await closePicker(page);
			const before = await readShown(draft.picker);
			const readsBefore = observed.requests.filter(
				(request) =>
					request.tag === "GetModels" && !request.payload?.["sessionId"],
			).length;
			await reconnectDraft(page);
			await expect
				.poll(
					() =>
						observed.requests.filter(
							(request) =>
								request.tag === "GetModels" && !request.payload?.["sessionId"],
						).length,
				)
				.toBeGreaterThan(readsBefore);
			const refresh = observed.requests
				.filter(
					(request) =>
						request.tag === "GetModels" && !request.payload?.["sessionId"],
				)
				.at(-1);
			await expect
				.poll(() =>
					observed.replies.some(({ request }) => request.id === refresh?.id),
				)
				.toBe(true);
			const reply = observed.replies.find(
				({ request }) => request.id === refresh?.id,
			);
			if (!reply) throw new Error("Reconnect GetModels omitted its reply");
			await observed.received([reply.frame]);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			await expectShown(draft.picker, before);
			await assertDraftReceipt(
				page,
				harness,
				draft,
				driver,
				`mdpt-${driver}`,
				observed,
				testInfo,
			);
		});
	}

	test("draft-catalog-isolation: a newly visited named OpenCode instance waits for its own models", async ({
		page,
		harness,
	}, testInfo) => {
		const caseId = "draft-catalog-isolation";
		let instanceB = "";
		let deliverEmpty = true;
		const delivered: {
			requestId: string | undefined;
			response: GetModelsResponse;
		}[] = [];
		const observed = await observeSessionRpc(
			page,
			undefined,
			(frame, request) => {
				if (
					(request.tag !== "GetModels" &&
						request.tag !== "SubscribeDraftModels") ||
					request.payload?.["instanceId"] !== instanceB ||
					request.payload?.["sessionId"]
				)
					return frame;
				return editModelInventories(frame, (response) => {
					const value: GetModelsResponse = deliverEmpty
						? {
								...response,
								providers: [],
								active: undefined,
								variant: undefined,
								contextWindow: undefined,
							}
						: response;
					delivered.push({
						requestId:
							request.id === undefined ? undefined : String(request.id),
						response: value,
					});
					return value;
				});
			},
		);
		let sessionA = "";
		const draft = await openDraft(
			page,
			harness,
			"opencode",
			async (browser, slug) => {
				const { instances } = await browser.instances();
				const instanceA = instances.find(
					(instance) => instance.id === "opencode",
				);
				if (!instanceA || (!instanceA.url && instanceA.port === 0))
					throw new Error(
						`The recorded OpenCode instance omitted its live URL: ${JSON.stringify(instanceA)}`,
					);
				const added = await Effect.runPromise(
					browser.rpc.AddInstance({
						projectSlug: slug,
						name: "Catalog B",
						driver: "opencode",
						managed: false,
						url: instanceA.url ?? `http://127.0.0.1:${instanceA.port}`,
					}),
				);
				if (!added.addedInstanceId)
					throw new Error("AddInstance did not return catalog instance B");
				instanceB = added.addedInstanceId;
				expect(instanceB).not.toBe("opencode");
				const created = await Effect.runPromise(
					browser.rpc.CreateSession({
						permissionMode: "ask",
						projectSlug: slug,
						originId: `${caseId}-a`,
						instanceId: AccountIdSchema.make("opencode"),
						model: {
							providerId: openCodeModel.providerID,
							modelId: openCodeModel.modelID,
							variant: "high",
							contextWindow: "",
						},
					}),
				);
				sessionA = created.sessionId;
			},
		);
		await new AppPage(page).goto(
			`${harness.baseUrl}/s/${encodeURIComponent(sessionA)}?p=${encodeURIComponent(draft.slug)}`,
		);
		await expect(draft.picker).toHaveAttribute("data-instance-id", "opencode");
		await expect(draft.picker).toHaveAttribute(
			"data-shown-model",
			openCodeModel.modelID,
		);
		const viewedA = await readShown(draft.picker);
		const aCatalog = await Effect.runPromise(
			draft.browser.rpc.GetModels({
				sessionId: sessionA,
			}),
		);
		if (!(await page.locator("#new-session-btn:visible").isVisible()))
			await page.getByTestId("session-bar-back").click();
		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		await expect(draft.picker).toHaveAttribute("data-instance-id", "opencode");
		await expect(draft.picker).toHaveAttribute(
			"data-shown-model",
			openCodeModel.modelID,
		);
		await expect
			.poll(() =>
				observed.replies.some(
					({ request }) =>
						request.tag === "GetModels" &&
						!request.payload?.["sessionId"] &&
						request.payload?.["instanceId"] === "opencode",
				),
			)
			.toBe(true);
		const aDraftReplies = observed.replies.filter(
			({ request }) =>
				request.tag === "GetModels" &&
				!request.payload?.["sessionId"] &&
				request.payload?.["instanceId"] === "opencode",
		);
		await observed.received(aDraftReplies.map(({ frame }) => frame));
		const held = observed.hold("GetModels", "undefined");
		const blocked: {
			phase: string;
			shown: Pick;
			instanceId: string | null;
			sendDisabled: boolean;
			models: { model: string | null; provider: string | null }[];
		}[] = [];
		let stage = "select-b";
		let proof: Awaited<ReturnType<typeof assertDraftReceipt>> | undefined;
		async function assertBlocked(phase: string) {
			const app = new AppPage(page);
			await app.input.fill(`${caseId}-first`);
			await openPickerRoot(page, draft.picker);
			await page.getByTestId("picker-row-model").click();
			const models = await page
				.getByTestId("model-picker-list")
				.locator("[data-model-id]")
				.evaluateAll((rows) =>
					rows.map((row) => ({
						model: row.getAttribute("data-model-id"),
						provider: row.getAttribute("data-provider-id"),
					})),
				);
			await closePicker(page);
			const snapshot = {
				phase,
				shown: await readShown(draft.picker),
				instanceId: await draft.picker.getAttribute("data-instance-id"),
				sendDisabled: await app.sendBtn.isDisabled(),
				models,
			};
			blocked.push(snapshot);
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.6",
				stage,
				instanceA: "opencode",
				instanceB,
				viewedA,
				aCatalog,
				blocked,
				delivered,
				heldReplies: held.frames,
			});
			expect(snapshot.instanceId).toBe(instanceB);
			expect(
				snapshot.shown.model,
				`${phase}: B cannot adopt A's held or default model`,
			).toBe("");
			expect(snapshot.shown.provider).toBe("");
			await expect(draft.picker).toHaveAccessibleName(
				phase === "b-reply-held" ? /Loading/ : /Select model/,
			);
			expect(
				snapshot.sendDisabled,
				`${phase}: B cannot send before a B model is selected`,
			).toBe(true);
			expect(
				snapshot.models,
				`${phase}: B cannot offer A's cached catalog`,
			).toEqual([]);
			expect(
				observed.requests.filter((request) => request.tag === "CreateSession"),
			).toEqual([]);
		}
		try {
			await openPickerRoot(page, draft.picker);
			await page.getByTestId(`picker-account-${instanceB}`).click();
			await held.wait;
			await closePicker(page);
			stage = "b-reply-held";
			await assertBlocked(stage);
			held.release();
			await observed.received(held.frames);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			stage = "b-empty-catalog-delivered";
			await assertBlocked(stage);
			expect(delivered.length).toBeGreaterThan(0);
			for (const reply of delivered)
				expect(reply.response.providers).toEqual([]);
			deliverEmpty = false;
			await openPickerRoot(page, draft.picker);
			await page.getByTestId("picker-account-opencode").click();
			await page.getByTestId(`picker-account-${instanceB}`).click();
			await closePicker(page);
			await expect
				.poll(() =>
					delivered.some((reply) => reply.response.providers.length > 0),
				)
				.toBe(true);
			const ownReply = delivered.find(
				(reply) => reply.response.providers.length > 0,
			);
			if (!ownReply) throw new Error("B did not receive its own catalog");
			const frame = observed.replies.find(
				({ request }) => String(request.id) === ownReply.requestId,
			)?.frame;
			if (!frame) throw new Error("B's catalog reply omitted its frame");
			await observed.received([frame]);
			const ownModel = ownReply.response.providers
				.find((provider) => provider.id === otherOpenCodeModel.providerID)
				?.models.find((model) => model.id === otherOpenCodeModel.modelID);
			expect(ownModel).toBeDefined();
			await pickModel(page, draft.picker, otherOpenCodeModel);
			await expect(draft.picker).toHaveAttribute("data-instance-id", instanceB);
			stage = "b-explicit-pick-first-send";
			proof = await assertDraftReceipt(
				page,
				harness,
				draft,
				"opencode",
				caseId,
				observed,
				testInfo,
			);
			stage = "complete";
		} finally {
			held.release();
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.6",
				stage,
				instanceA: "opencode",
				instanceB,
				viewedA,
				aCatalog,
				blocked,
				delivered,
				heldReplies: held.frames,
				...proof,
			});
		}
	});

	test("4t9q: an OpenCode draft discovers OpenCode models and agents with a Claude project default", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const draft = await openDraft(page, harness, "claude", async (browser) => {
			await browser.startInstance("opencode");
		});
		const requestBoundary = observed.requests.length;
		await selectDraftHarness(page, draft.picker, "opencode");
		await expect(draft.picker).toHaveAttribute("data-shown-model", /.+/);
		const models = await Effect.runPromise(
			draft.browser.rpc.GetModels({
				projectSlug: draft.slug,
				instanceId: "opencode",
			}),
		);
		const agents = await Effect.runPromise(
			draft.browser.rpc.GetAgents({
				projectSlug: draft.slug,
				instanceId: "opencode",
			}),
		);
		await openPickerRoot(page, draft.picker);
		await page.getByTestId("picker-row-model").click();
		const displayedModels = await page
			.getByTestId("model-picker-list")
			.locator("[data-model-id]")
			.evaluateAll((rows) =>
				rows.map((row) => ({
					provider: row.getAttribute("data-provider-id"),
					model: row.getAttribute("data-model-id"),
				})),
			);
		const catalogModels = models.providers.flatMap((provider) =>
			provider.models.map((model) => ({
				provider: provider.id,
				model: model.id,
			})),
		);
		expect(displayedModels.length).toBeGreaterThan(0);
		for (const model of displayedModels)
			expect(catalogModels).toContainEqual(model);
		expect(displayedModels.every((model) => model.provider !== "claude")).toBe(
			true,
		);
		await page.getByTestId("picker-back").click();
		await page.getByTestId("picker-row-agent").click();
		const agentRows = page.locator('[data-testid^="picker-agent-"]:visible');
		await expect(agentRows.first()).toBeVisible();
		const displayedAgents = await agentRows.evaluateAll((rows) =>
			rows.map((row) => ({
				id: row.getAttribute("data-testid")?.replace("picker-agent-", ""),
				text: row.textContent,
			})),
		);
		for (const agent of displayedAgents)
			expect(agents.agents.some((entry) => entry.id === agent.id)).toBe(true);
		expect(
			displayedAgents.some((agent) => agent.id === "claude-draft-agent"),
		).toBe(false);
		await closePicker(page);
		const reads = observed.requests
			.slice(requestBoundary)
			.filter((request) =>
				["GetModels", "SubscribeDraftModels", "GetAgents"].includes(
					request.tag ?? "",
				),
			);
		const proof = await assertDraftReceipt(
			page,
			harness,
			draft,
			"opencode",
			"4t9q",
			observed,
			testInfo,
		);
		await writeGuardArtifact(testInfo, {
			case: "4t9q",
			bead: "conduit-test-4t9q",
			...proof,
			displayedModels,
			displayedAgents,
			models,
			agents,
			reads,
		});
		expect(agents.providerScope.id).toBe("opencode");
		for (const tag of ["GetModels", "GetAgents"]) {
			const scoped = reads.filter(
				(request) =>
					request.tag === tag ||
					(tag === "GetModels" && request.tag === "SubscribeDraftModels"),
			);
			expect(scoped.length).toBeGreaterThan(0);
			for (const request of scoped)
				expect(request.payload).toMatchObject({ instanceId: "opencode" });
		}
	});
});

for (const status of ["missing", "invalid", "empty-catalog"] as const) {
	test.describe(`draft default ${status}`, () => {
		test.use({
			harnessOptions: {
				opencodeRecording: "chat-simple",
				capabilityModels: claudeModels,
				relaySettings: {
					defaultModel: "claude/sonnet",
					harnessDefaults: {
						claude: {
							providerId: "claude",
							modelId: "sonnet",
							contextWindow: "200k",
						},
						...(status === "missing"
							? {}
							: {
									opencode: {
										providerId: "opencode",
										modelId:
											status === "invalid"
												? "missing-model"
												: openCodeModel.modelID,
										contextWindow: "",
									},
								}),
					},
				},
			},
		});
		test(`draft-no-default-${status}: select model is required before sending`, async ({
			page,
			harness,
		}, testInfo) => {
			let emptyCatalog = status === "empty-catalog";
			const observed = await observeSessionRpc(
				page,
				undefined,
				(frame, request) => {
					if (
						emptyCatalog &&
						(request.tag === "GetModels" ||
							request.tag === "SubscribeDraftModels") &&
						request.payload?.["instanceId"] === "opencode"
					) {
						return editModelInventories(frame, (response) => ({
							...response,
							providers: [],
							active: undefined,
							variant: undefined,
							contextWindow: undefined,
						}));
					}
					return frame;
				},
			);
			const draft = await openDraft(
				page,
				harness,
				"claude",
				async (browser) => {
					await browser.startInstance("opencode");
				},
				"claude",
				false,
			);
			await selectDraftHarness(page, draft.picker, "opencode");
			await expect(draft.picker).toHaveAttribute("data-shown-model", "");
			await expect(draft.picker).toHaveAccessibleName(/Select model/);
			const app = new AppPage(page);
			await app.input.fill(`draft-no-default-${status}-first`);
			await expect(app.sendBtn).toBeDisabled();
			const blocked = {
				shown: await readShown(draft.picker),
				sendDisabled: await app.sendBtn.isDisabled(),
				creates: observed.requests.filter(
					(request) => request.tag === "CreateSession",
				),
			};
			if (emptyCatalog) {
				await openPickerRoot(page, draft.picker);
				await page.getByTestId("picker-row-model").click();
				await expect(
					page.getByTestId("model-picker-list").locator("[data-model-id]"),
				).toHaveCount(0);
				await closePicker(page);
				emptyCatalog = false;
				await selectDraftHarness(page, draft.picker, "claude");
				await selectDraftHarness(page, draft.picker, "opencode");
			}
			await pickModel(page, draft.picker, openCodeModel);
			await expect(app.sendBtn).toBeEnabled();
			const blockedFile = testInfo.outputPath("blocked-draft.json");
			writeFileSync(blockedFile, JSON.stringify(blocked, null, 2));
			await testInfo.attach("blocked-draft.json", {
				path: blockedFile,
				contentType: "application/json",
			});
			expect(blocked.creates).toEqual([]);
			await assertDraftReceipt(
				page,
				harness,
				draft,
				"opencode",
				`draft-no-default-${status}`,
				observed,
				testInfo,
			);
		});
	});
}

test("zjdq: OpenCode draft with a Claude default", async ({
	page,
	harness,
}, testInfo) => {
	const { slug, picker } = await openDraft(
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
		null,
	);
	await selectDraftHarness(page, picker, "opencode");
	await expect(picker).toHaveAttribute("data-shown-model", /.+/);
	const shown = await readShown(picker);
	const sent = await sendAndCapture(page, harness, "opencode", "zjdq-first");
	const sessionId = decodeURIComponent(
		new URL(page.url()).pathname.match(/\/s\/([^/]+)/)?.[1] ?? "",
	);
	await assertParity(
		{
			case: "zjdq",
			bead: "conduit-test-zjdq",
			harness: "opencode",
			flow: "draft first send",
			change: "Claude project default set",
		},
		shown,
		sent,
		testInfo,
		undefined,
		readStoredState(harness, slug, sessionId),
	);
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
			permissionMode: "ask",
			projectSlug: draft.slug,
			originId: caseId,
			instanceId: AccountIdSchema.make("claude"),
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

test("switch-model-keeps-context: sonnet 1m switched to opus still sends 1m", async ({
	page,
	harness,
}, testInfo) => {
	const caseId = "switch-model-keeps-context";
	const { browser, slug, sessionId, picker } = await createStoredPickSession(
		page,
		harness,
		caseId,
		"1m",
	);
	const before = readStoredState(harness, slug, sessionId);
	await Effect.runPromise(
		browser.rpc.SwitchModel({
			sessionId,
			modelId: "opus",
			providerId: "claude",
		}),
	);
	const after = readStoredState(harness, slug, sessionId);
	const reported = await Effect.runPromise(
		browser.rpc.GetModels({ sessionId }),
	);
	let sent: Pick | undefined;
	const prompt = `${caseId}-next`;
	try {
		await expect(picker).toHaveAttribute("data-shown-model", "opus");
		sent = await sendAndCapture(page, harness, "claude", prompt, true);
	} finally {
		await writeGuardArtifact(testInfo, {
			case: caseId,
			bead: "conduit-test-fmg0.4",
			before,
			after,
			reported,
			sent,
			providerReceipts: enqueues(harness, true).filter(
				(mark) => mark.prompt === prompt,
			),
		});
	}
	expect(before.pick).toMatchObject({
		model_id: "sonnet",
		context_window: "1m",
	});
	expect(after.pick).toMatchObject({ model_id: "opus", context_window: "1m" });
	expect(
		after.pickEvents.filter(
			(event) => event.type === "session.context_window_changed",
		),
	).toEqual(
		before.pickEvents.filter(
			(event) => event.type === "session.context_window_changed",
		),
	);
	expect(reported.contextWindow?.contextWindow).toBe("1m");
	expect(sent).toMatchObject({ model: "opus", contextWindow: "1m" });
	expect(
		enqueues(harness, true).find((mark) => mark.prompt === prompt)?.liveOptions
			.model,
	).toBe("opus[1m]");
});

test("pick-required-permission-create: missing permission mode rejects before session creation", async ({
	page,
	harness,
}, testInfo) => {
	let sentPayload: Readonly<Record<string, unknown>> | undefined;
	const rpc = await observeSessionRpc(page, (frame) => {
		if (frame.tag !== "CreateSession") return frame;
		const { permissionMode: _permissionMode, ...payload } = frame.payload ?? {};
		sentPayload = payload;
		return { ...frame, payload };
	});
	const { slug, picker } = await openDraft(
		page,
		harness,
		"claude",
		async (browser, projectSlug) => {
			await Effect.runPromise(
				browser.rpc.SetDefaultPermissionMode({
					projectSlug,
					mode: "full",
				}),
			);
		},
	);
	const shown = {
		...(await readShown(picker)),
		permissionMode: await picker.getAttribute("data-shown-permission-mode"),
	};
	const snapshot = () => ({
		sessions: readStoredState(harness, slug, "").sessionCount,
		claudePrompts: enqueues(harness, true).length,
		openCodePrompts: openCodePrompts(harness).length,
		upstreamCreates: harness
			.opencodeRequestBodies()
			.filter(
				(request) =>
					request.method === "POST" && /^\/session\/?$/.test(request.path),
			).length,
	});
	const before = snapshot();
	await page.locator("#input").fill("must reject a missing permission mode");
	await page.locator("#send").click();
	await expect
		.poll(() =>
			rpc.replies.some(({ request }) => request.tag === "CreateSession"),
		)
		.toBe(true);
	const reply = rpc.replies.find(
		({ request }) => request.tag === "CreateSession",
	);
	const after = snapshot();
	await writeGuardArtifact(testInfo, {
		case: "pick-required-permission-create",
		bead: "conduit-test-fmg0.6",
		shown,
		originalPayload: reply?.request.payload,
		sentPayload,
		reply: reply?.frame,
		before,
		after,
		expectedRejection: "missing permissionMode",
	});
	expect(shown.permissionMode).toBe("full");
	expect(reply?.request.payload?.["permissionMode"]).toBe("full");
	expect(sentPayload).not.toHaveProperty("permissionMode");
	expect(sentPayload?.["model"]).toEqual(reply?.request.payload?.["model"]);
	expect(reply?.frame.exit?._tag).toBe("Failure");
	expect(JSON.stringify(reply?.frame)).toContain("permissionMode");
	expect(after).toEqual(before);
	await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
});

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
				Effect.result(
					browser.rpc
						.CreateSession({
							permissionMode: "ask",
							projectSlug: slug,
							originId: "pick-required-create",
							instanceId: AccountIdSchema.make("opencode"),
							...(model ? { model } : {}),
						})
						.pipe(Effect.timeout("10 seconds")),
				),
			);
			errors.push(result._tag === "Failure" ? result.failure : undefined);
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
	const db = new Database(harness.daemonStorePath());
	try {
		expect(
			db
				.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
			variant = NULL, context_window = NULL WHERE id = ?`)
				.run(sessionId).changes,
		).toBe(1);
		// Deliberately reset the daemon-wide singleton: these isolated fixtures
		// exercise the first store-wide pick repair across all registered projects.
		db.exec(
			"UPDATE session_pick_backfill_state SET initialized = 0 WHERE singleton = 1",
		);
	} finally {
		db.close();
	}
	const legacy = readStoredState(harness, slug, sessionId);
	const restorations: ReturnType<typeof readStoredState>[] = [];
	const sampledModels: GetModelsResponse[] = [];
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
			let models = await Effect.runPromise(
				restoredBrowser.rpc.GetModels({ sessionId }),
			);
			sampledModels.push(models);
			// Restart serves a persisted catalog while capability discovery refreshes it.
			await expect
				.poll(async () => {
					models = await Effect.runPromise(
						restoredBrowser.rpc.GetModels({ sessionId }),
					);
					sampledModels.push(models);
					return {
						model: models.active?.model ?? "",
						provider: models.active?.provider ?? "",
						effort: models.variant?.variant ?? "",
						contextWindow: models.contextWindow?.contextWindow ?? "",
					};
				})
				.toEqual({
					model: "sonnet",
					provider: "claude",
					effort: "high",
					contextWindow: "200k",
				});
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
			sampledModels,
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
	for (const models of sampledModels) {
		if (models.active)
			expect(models).toMatchObject({
				active: { model: "sonnet", provider: "claude" },
				variant: { variant: "high" },
				contextWindow: { contextWindow: "200k" },
			});
	}
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
			permissionMode: "ask",
			projectSlug: slug,
			originId: caseId,
			instanceId: AccountIdSchema.make("opencode"),
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
	const receiptDb = new Database(harness.daemonStorePath(), {
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
	const db = new Database(harness.daemonStorePath());
	try {
		expect(
			db
				.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
			variant = NULL, context_window = NULL WHERE id = ?`)
				.run(sessionId).changes,
		).toBe(1);
		// Deliberately reset the daemon-wide singleton: these isolated fixtures
		// exercise the first store-wide pick repair across all registered projects.
		db.exec(
			"UPDATE session_pick_backfill_state SET initialized = 0 WHERE singleton = 1",
		);
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
				restoredBrowser.rpc.GetModels({ sessionId }),
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

test("legacy-partial-pick-backfill: fills NULL effort and context while preserving explicit empties", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(240_000);
	const caseId = "legacy-partial-pick-backfill";
	const { browser, slug, sessionId } = await createStoredPickSession(
		page,
		harness,
		caseId,
	);
	await sendAndCapture(page, harness, "claude", `${caseId}-both-null`, true);
	const samples = [{ sessionId, variant: null, contextWindow: null }] as {
		sessionId: string;
		variant: string | null;
		contextWindow: string | null;
	}[];
	for (const empty of ["effort", "context"] as const) {
		const created = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug: slug,
				originId: `${caseId}-${empty}`,
				instanceId: AccountIdSchema.make("claude"),
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "high",
					contextWindow: "200k",
				},
			}),
		);
		const prompt = `${caseId}-empty-${empty}`;
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: created.sessionId,
				inputId: prompt,
				originId: caseId,
				delivery: "queue",
				text: prompt,
			}),
		);
		await expect
			.poll(() =>
				enqueues(harness, true).some((mark) => mark.prompt === prompt),
			)
			.toBe(true);
		const receiptDb = new Database(harness.daemonStorePath(), {
			readonly: true,
		});
		try {
			await expect
				.poll(
					() =>
						receiptDb
							.prepare<[string], { count: number }>(
								"SELECT count(*) AS count FROM turns WHERE session_id = ? AND started_at IS NOT NULL",
							)
							.get(created.sessionId)?.count,
				)
				.toBe(1);
		} finally {
			receiptDb.close();
		}
		samples.push({
			sessionId: created.sessionId,
			variant: empty === "effort" ? "" : null,
			contextWindow: empty === "context" ? "" : null,
		});
	}
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	const before = samples.map((sample) =>
		readStoredState(harness, slug, sample.sessionId),
	);
	await browser.close();
	await harness.terminate();
	const db = new Database(harness.daemonStorePath());
	let executedTurns: { session_id: string; started_at: number | null }[];
	try {
		executedTurns = db
			.prepare<[string], { session_id: string; started_at: number | null }>(
				"SELECT t.session_id, t.started_at FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? ORDER BY t.requested_at",
			)
			.all(slug);
		for (const sample of samples)
			db.prepare(
				"UPDATE sessions SET variant = ?, context_window = ? WHERE id = ?",
			).run(sample.variant, sample.contextWindow, sample.sessionId);
		// Deliberately reset the daemon-wide singleton: these isolated fixtures
		// exercise the first store-wide pick repair across all registered projects.
		db.exec(
			"UPDATE session_pick_backfill_state SET initialized = 0 WHERE singleton = 1",
		);
	} finally {
		db.close();
	}
	const legacy = samples.map((sample) =>
		readStoredState(harness, slug, sample.sessionId),
	);
	const restorations: ReturnType<typeof readStoredState>[][] = [];
	try {
		for (let restart = 0; restart < 2; restart++) {
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 30_000,
			});
			restorations.push(
				samples.map((sample) =>
					readStoredState(harness, slug, sample.sessionId),
				),
			);
			if (restart === 0) await harness.terminate();
		}
	} finally {
		await writeGuardArtifact(testInfo, {
			case: caseId,
			bead: "conduit-test-fmg0.4",
			samples,
			executedTurns,
			before,
			legacy,
			restorations,
		});
	}
	for (const [index, sample] of samples.entries()) {
		expect(
			typeof executedTurns.find((turn) => turn.session_id === sample.sessionId)
				?.started_at,
		).toBe("number");
		const expected = {
			provider: "claude",
			model_id: "sonnet",
			model_provider: "claude",
			variant: sample.variant ?? "high",
			context_window: sample.contextWindow ?? "200k",
		};
		expect(restorations[0]?.[index]?.pick).toEqual(expected);
		expect(restorations[1]?.[index]?.pick).toEqual(expected);
		expect(restorations[1]?.[index]?.pickEvents).toEqual(
			restorations[0]?.[index]?.pickEvents,
		);
		const added = restorations[0]?.[index]?.pickEvents.slice(
			before[index]?.pickEvents.length,
		);
		expect(added?.map((event) => event.type)).toEqual([
			...(sample.variant === null ? ["session.variant_changed"] : []),
			...(sample.contextWindow === null
				? ["session.context_window_changed"]
				: []),
		]);
	}
});

test("legacy-executed-unrecoverable-pick: a turn without a recoverable model never adopts a default", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(240_000);
	const caseId = "legacy-executed-unrecoverable-pick";
	const { browser, slug, sessionId } = await createStoredPickSession(
		page,
		harness,
		caseId,
	);
	await sendAndCapture(page, harness, "claude", `${caseId}-before`, true);
	await Effect.runPromise(
		browser.rpc.SetDefaultModel({
			projectSlug: slug,
			model: "opus",
			provider: "claude",
		}),
	);
	const before = readStoredState(harness, slug, sessionId);
	const receiptsBefore = enqueues(harness, true).length;
	await browser.close();
	await harness.terminate();
	const db = new Database(harness.daemonStorePath());
	let history:
		| {
				started_at: number | null;
				requested_model: string | null;
				actual_model: string | null;
				expected_model: string | null;
		  }
		| undefined;
	try {
		db.transaction(() => {
			db.prepare(
				`UPDATE sessions SET model_id = NULL, model_provider = NULL,
				 variant = NULL, context_window = NULL WHERE id = ?`,
			).run(sessionId);
			db.prepare(
				`UPDATE turns SET requested_model = NULL, actual_model = NULL,
				 expected_model = NULL WHERE session_id = ?`,
			).run(sessionId);
			db.prepare(
				`UPDATE messages SET rest_payload = json_remove(rest_payload,
				 '$.model', '$.modelID', '$.providerID') WHERE session_id = ?`,
			).run(sessionId);
			db.prepare(
				`UPDATE provider_command_outbox SET payload_json =
				 json_remove(payload_json, '$.model') WHERE session_id = ?`,
			).run(sessionId);
		})();
		history = db
			.prepare<[string], NonNullable<typeof history>>(
				`SELECT started_at, requested_model, actual_model, expected_model
				 FROM turns WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1`,
			)
			.get(sessionId);
	} finally {
		db.close();
	}
	const legacy = readStoredState(harness, slug, sessionId);
	await harness.restart({
		startupTimeoutMs: 60_000,
		runnerStartupTimeoutMs: 30_000,
	});
	const restarted = readStoredState(harness, slug, sessionId);
	const restoredBrowser = await harness.connect(sessionId, caseId, slug);
	let after = restarted;
	try {
		await Effect.runPromise(
			restoredBrowser.rpc["input.submit"]({
				sessionId,
				inputId: `${caseId}-rejected`,
				originId: caseId,
				delivery: "queue",
				text: `${caseId}-rejected`,
			}),
		);
		await expect
			.poll(() => {
				after = readStoredState(harness, slug, sessionId);
				return after.turnErrors.length;
			})
			.toBe(before.turnErrors.length + 1);
	} finally {
		await writeGuardArtifact(testInfo, {
			case: caseId,
			bead: "conduit-test-fmg0.4",
			history,
			before,
			legacy,
			restarted,
			after,
			expectedCode: "PICK_REQUIRED",
			receiptsBefore,
			receiptsAfter: enqueues(harness, true).length,
		});
	}
	expect(typeof history?.started_at).toBe("number");
	expect(history).toMatchObject({
		requested_model: null,
		actual_model: null,
		expected_model: null,
	});
	expect(restarted.pick).toEqual(legacy.pick);
	expect(restarted.pick?.model_id).toBeNull();
	expect(after.pickEvents).toEqual(before.pickEvents);
	expect(JSON.parse(after.turnErrors.at(-1)?.data ?? "{}")).toMatchObject({
		code: "PICK_REQUIRED",
	});
	expect(enqueues(harness, true).length).toBe(receiptsBefore);
});

test.describe("OpenCode draft inventory borrows", () => {
	// The daemon receives this only through the isolated process fixture's
	// CONDUIT_TEST_OPENCODE_BORROW_IDLE_TIMEOUT_MS test-only environment knob.
	const borrowIdleTimeoutMs = 1_000;
	const model = { providerID: "fake", modelID: "fake-model" };
	const namedModel = { providerID: "fake", modelID: "named-model" };
	test.use({
		harnessOptions: {
			managedOpenCode: true,
			managedOpenCodeId: "opencode",
			opencodeBorrowIdleTimeoutMs: borrowIdleTimeoutMs,
			capabilityModels: claudeModels,
			restartProof: true,
		},
	});

	async function prepareDraft(
		harness: ProcessHarness,
		driver: Driver = "claude",
		instanceId = "opencode",
	) {
		const directory = mkdtempSync(join(harness.root, "borrow-project-"));
		const browser = await harness.connect();
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory] }),
		);
		if (!slug) throw new Error("SaveProject did not return a slug");
		await Effect.runPromise(
			browser.rpc.SetDefaultModel({
				projectSlug: slug,
				provider: driver === "claude" ? "claude" : model.providerID,
				model: driver === "claude" ? "sonnet" : model.modelID,
			}),
		);
		for (const harness of ["claude", "opencode"] as const)
			await Effect.runPromise(
				browser.rpc.SetHarnessDefault({
					projectSlug: slug,
					harness,
					providerId: harness === "claude" ? "claude" : model.providerID,
					modelId: harness === "claude" ? "sonnet" : model.modelID,
					effort: harness === "claude" ? "low" : "",
					contextWindow: harness === "claude" ? "200k" : "",
				}),
			);
		const defaultCatalog = await Effect.runPromise(
			browser.rpc.GetModels({ projectSlug: slug }),
		);
		// Default validation can use the provider during fixture setup. The
		// browser must begin with it stopped, as an idle-stopped draft would.
		await browser.stopInstance(instanceId);
		const initialInstance = (await browser.instances()).instances.find(
			(instance) => instance.id === instanceId,
		);
		expect(initialInstance?.status).toBe("stopped");
		return { browser, slug, defaultCatalog, initialInstance };
	}

	async function openDraftPage(
		page: Page,
		harness: ProcessHarness,
		slug: string,
		driver: Driver = "claude",
	) {
		await new AppPage(page).goto(
			`${harness.baseUrl}/new?p=${encodeURIComponent(slug)}`,
		);
		await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
		const picker = page.locator(pickerSelector);
		await expect(picker).toHaveAttribute("data-shown-harness", driver);
		return picker;
	}

	async function instance(browser: ProcessBrowser, instanceId = "opencode") {
		return (await browser.instances()).instances.find(
			(entry) => entry.id === instanceId,
		);
	}

	async function waitForHealthy(
		browser: ProcessBrowser,
		instanceId = "opencode",
	) {
		await expect
			.poll(async () => (await instance(browser, instanceId))?.status, {
				timeout: 20_000,
			})
			.toBe("healthy");
		const running = await instance(browser, instanceId);
		expect(running?.pid).toBeGreaterThan(0);
		expect(isProcessAlive(running?.pid ?? 0)).toBe(true);
		return running;
	}

	async function unboundState(setup: Awaited<ReturnType<typeof prepareDraft>>) {
		const sessions = await Effect.runPromise(
			setup.browser.rpc.ListDaemonSessions({ projectSlug: setup.slug }),
		);
		const defaults = await Effect.runPromise(
			setup.browser.rpc.GetModels({ projectSlug: setup.slug }),
		);
		return {
			sessions: sessions.sessions,
			projectDefault: {
				instanceId: defaults.instanceId,
				active: defaults.active,
			},
		};
	}

	async function sendShownPick(
		page: Page,
		harness: ProcessHarness,
		picker: Locator,
		slug: string,
		caseId: string,
		observed: Awaited<ReturnType<typeof observeSessionRpc>>,
		instanceId = "opencode",
	) {
		const shown = await readShown(picker);
		await new AppPage(page).sendMessage(caseId);
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		await expect.poll(() => openCodePrompts(harness).length).toBe(1);
		const providerReceipt = openCodePrompts(harness)[0];
		const sent = JSON.parse(providerReceipt?.body ?? "{}") as {
			model?: { providerID: string; modelID: string };
			variant?: string;
		};
		const sessionId = decodeURIComponent(
			new URL(page.url()).pathname.match(/\/s\/([^/]+)/)?.[1] ?? "",
		);
		const creates = observed.requests.filter(
			(request) => request.tag === "CreateSession",
		);
		expect(creates).toHaveLength(1);
		expect(creates[0]?.payload).toMatchObject({
			instanceId,
			model: {
				providerId: shown.provider,
				modelId: shown.model,
				variant: shown.effort,
				contextWindow: shown.contextWindow,
			},
		});
		expect(shown.harness).toBe("opencode");
		expect(sent.model).toEqual({
			providerID: shown.provider,
			modelID: shown.model,
		});
		expect(sent.variant ?? "").toBe(shown.effort);
		const stored = readStoredState(harness, slug, sessionId);
		expect(stored.pick).toMatchObject({
			provider: instanceId,
			model_provider: shown.provider,
			model_id: shown.model,
			variant: shown.effort,
		});
		return { shown, creates, sessionId, providerReceipt, sent, stored };
	}

	async function addNamedInstance(
		setup: Awaited<ReturnType<typeof prepareDraft>>,
		harness: ProcessHarness,
	) {
		const port = await new Promise<number>((done, fail) => {
			const server = createServer();
			server.once("error", fail);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					server.close(() => fail(new Error("No named OpenCode port")));
					return;
				}
				server.close(() => done(address.port));
			});
		});
		writeFileSync(
			join(harness.configDir, "fake-opencode-named-model-catalog.json"),
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Named Provider",
						models: {
							"named-model": {
								id: "named-model",
								name: "Named Model",
								limit: { context: 128000, output: 4096 },
								variants: { high: {} },
							},
						},
					},
				],
				default: { fake: "named-model" },
				connected: ["fake"],
			}),
		);
		const added = await Effect.runPromise(
			setup.browser.rpc.AddInstance({
				projectSlug: setup.slug,
				name: "Borrow named instance",
				driver: "opencode",
				managed: true,
				port,
				env: { CONDUIT_TEST_OPENCODE_STATE_PREFIX: "named" },
			}),
		);
		if (!added.addedInstanceId)
			throw new Error("AddInstance omitted the named id");
		return added.addedInstanceId;
	}

	test("9cn3-a: stopped OpenCode starts for a draft without binding and sends the displayed pick", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const setup = await prepareDraft(harness);
		const evidence: Record<string, unknown> = {
			case: "9cn3-a",
			bead: "conduit-test-9cn3",
			initialInstance: setup.initialInstance,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			expect((await instance(setup.browser))?.status).toBe("stopped");
			expect(
				observed.requests.filter(
					(request) => request.tag === "SubscribeDraftModels",
				),
			).toEqual([]);
			const before = await unboundState(setup);
			evidence["before"] = before;
			await selectDraftHarness(page, picker, "opencode");
			const running = await waitForHealthy(setup.browser);
			evidence["running"] = running;
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-row-model").click();
			await expect(
				page
					.getByTestId("model-picker-list")
					.locator(
						`[data-model-id="${model.modelID}"][data-provider-id="${model.providerID}"]`,
					),
			).toBeVisible();
			await closePicker(page);
			const after = await unboundState(setup);
			evidence["afterBorrow"] = after;
			expect(after.sessions).toEqual([]);
			expect(after.projectDefault).toEqual(before.projectDefault);
			expect(
				observed.requests.filter((request) =>
					["CreateSession", "SwitchInstance"].includes(request.tag ?? ""),
				),
			).toEqual([]);
			evidence["receipt"] = await sendShownPick(
				page,
				harness,
				picker,
				setup.slug,
				"9cn3-a",
				observed,
			);
		} finally {
			evidence["finalInstance"] = await instance(setup.browser);
			evidence["requests"] = observed.requests;
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	for (const phase of ["starting", "healthy"] as const) {
		test.describe(`release while ${phase}`, () => {
			test.use({
				harnessOptions: {
					managedOpenCode: true,
					managedOpenCodeId: "opencode",
					opencodeBorrowIdleTimeoutMs: borrowIdleTimeoutMs,
					capabilityModels: claudeModels,
					restartProof: true,
				},
			});
			test(`9cn3-b-${phase}: switching to Claude releases the borrow and preserves its pick`, async ({
				page,
				harness,
			}, testInfo) => {
				const setup = await prepareDraft(harness);
				const healthGate = join(harness.configDir, "fake-opencode-hold-health");
				const evidence: Record<string, unknown> = {
					case: `9cn3-b-${phase}`,
					bead: "conduit-test-9cn3",
					borrowIdleTimeoutMs,
					initialInstance: setup.initialInstance,
				};
				try {
					const picker = await openDraftPage(page, harness, setup.slug);
					await expect(picker).toHaveAttribute("data-shown-model", "sonnet");
					const claudeBefore = await readShown(picker);
					evidence["claudeBefore"] = claudeBefore;
					const pidsBeforeBorrow = harness.ownedOpenCodePids();
					if (phase === "starting") writeFileSync(healthGate, "test-only");
					await selectDraftHarness(page, picker, "opencode");
					if (phase === "starting") {
						await expect
							.poll(async () => (await instance(setup.browser))?.status)
							.toBe("starting");
						await openPickerRoot(page, picker);
						await page.getByTestId("picker-row-model").click();
						await expect(page.getByTestId("model-picker-list")).toContainText(
							/Loading|Starting/i,
						);
						await expect(
							page.getByTestId("model-picker-list"),
						).not.toContainText("No models available");
						await expect(picker).not.toHaveAttribute(
							"data-shown-model",
							claudeBefore.model,
						);
						const app = new AppPage(page);
						await app.input.fill("9cn3-b-starting");
						await expect(app.sendBtn).toBeDisabled();
						evidence["starting"] = {
							instance: await instance(setup.browser),
							shown: await readShown(picker),
							modelList: await page
								.getByTestId("model-picker-list")
								.innerText(),
							sendDisabled: await app.sendBtn.isDisabled(),
						};
						await closePicker(page);
					} else {
						evidence["running"] = await waitForHealthy(setup.browser);
						await expect(picker).toHaveAttribute(
							"data-shown-model",
							model.modelID,
						);
					}
					await selectDraftHarness(page, picker, "claude");
					await expectShown(picker, claudeBefore);
					rmSync(healthGate, { force: true });
					const releasedAt = Date.now();
					await expect
						.poll(
							() =>
								harness
									.ownedOpenCodePids()
									.filter((pid) => !pidsBeforeBorrow.includes(pid)).length,
						)
						.toBeGreaterThan(0);
					const ownedPids = harness
						.ownedOpenCodePids()
						.filter((pid) => !pidsBeforeBorrow.includes(pid));
					evidence["ownedPids"] = ownedPids;
					await expect
						.poll(async () => (await instance(setup.browser))?.status, {
							timeout: 20_000,
						})
						.toBe("stopped");
					await expect.poll(() => ownedPids.filter(isProcessAlive)).toEqual([]);
					await expectShown(picker, claudeBefore);
					evidence["claudeAfter"] = await readShown(picker);
					evidence["releaseToStoppedMs"] = Date.now() - releasedAt;
					const unbound = await unboundState(setup);
					evidence["unbound"] = unbound;
					expect(unbound.sessions).toEqual([]);
				} finally {
					rmSync(healthGate, { force: true });
					evidence["finalInstance"] = await instance(setup.browser);
					await writeGuardArtifact(testInfo, evidence);
				}
			});
		});
	}

	async function staysHealthy(
		browser: ProcessBrowser,
		pid: number | undefined,
	) {
		const samples: {
			at: number;
			status: string | undefined;
			pid: number | undefined;
		}[] = [];
		const until = Date.now() + borrowIdleTimeoutMs * 2 + 250;
		await expect
			.poll(
				async () => {
					const running = await instance(browser);
					samples.push({
						at: Date.now(),
						status: running?.status,
						pid: running?.pid,
					});
					return Date.now() >= until;
				},
				{ intervals: [200], timeout: 10_000 },
			)
			.toBe(true);
		expect(
			samples.every(
				(sample) => sample.status === "healthy" && sample.pid === pid,
			),
		).toBe(true);
		expect(isProcessAlive(pid ?? 0)).toBe(true);
		return samples;
	}

	test("9cn3-b-running: releasing a draft never stops an instance that was already running", async ({
		page,
		harness,
	}, testInfo) => {
		const setup = await prepareDraft(harness);
		await setup.browser.startInstance("opencode");
		const runningBeforeDraft = await waitForHealthy(setup.browser);
		const evidence: Record<string, unknown> = {
			case: "9cn3-b-running",
			bead: "conduit-test-9cn3",
			borrowIdleTimeoutMs,
			runningBeforeDraft,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			const claudeBefore = await readShown(picker);
			await selectDraftHarness(page, picker, "opencode");
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			await selectDraftHarness(page, picker, "claude");
			await expectShown(picker, claudeBefore);
			evidence["samplesAfterRelease"] = await staysHealthy(
				setup.browser,
				runningBeforeDraft?.pid,
			);
			evidence["unbound"] = await unboundState(setup);
		} finally {
			evidence["finalInstance"] = await instance(setup.browser);
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("9cn3-c: a real session turn promotes a borrowed instance before release", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const setup = await prepareDraft(harness);
		const evidence: Record<string, unknown> = {
			case: "9cn3-c",
			bead: "conduit-test-9cn3",
			borrowIdleTimeoutMs,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			await selectDraftHarness(page, picker, "opencode");
			const borrowed = await waitForHealthy(setup.browser);
			evidence["borrowed"] = borrowed;
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			evidence["receipt"] = await sendShownPick(
				page,
				harness,
				picker,
				setup.slug,
				"9cn3-c",
				observed,
			);
			await new AppPage(page).goto(
				`${harness.baseUrl}/new?p=${encodeURIComponent(setup.slug)}`,
			);
			await selectDraftHarness(page, picker, "claude");
			await expect(picker).toHaveAttribute("data-shown-model", "sonnet");
			evidence["samplesAfterTurnAndRelease"] = await staysHealthy(
				setup.browser,
				borrowed?.pid,
			);
		} finally {
			evidence["finalInstance"] = await instance(setup.browser);
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("9cn3-d: a stopped OpenCode project default starts and fills a new draft on page load", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const setup = await prepareDraft(harness, "opencode");
		const evidence: Record<string, unknown> = {
			case: "9cn3-d",
			bead: "conduit-test-9cn3",
			initialInstance: setup.initialInstance,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug, "opencode");
			evidence["running"] = await waitForHealthy(setup.browser);
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			await expect(picker).toHaveAttribute(
				"data-shown-provider",
				model.providerID,
			);
			const app = new AppPage(page);
			await app.input.fill("9cn3-d");
			await expect(app.sendBtn).toBeEnabled();
			const unbound = await unboundState(setup);
			expect(unbound.sessions).toEqual([]);
			evidence["beforePickerOpened"] = {
				shown: await readShown(picker),
				sendEnabled: await app.sendBtn.isEnabled(),
				unbound,
			};
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-row-model").click();
			await expect(
				page
					.getByTestId("model-picker-list")
					.locator(
						`[data-model-id="${model.modelID}"][data-provider-id="${model.providerID}"]`,
					),
			).toBeVisible();
			await closePicker(page);
			evidence["receipt"] = await sendShownPick(
				page,
				harness,
				picker,
				setup.slug,
				"9cn3-d",
				observed,
			);
		} finally {
			evidence["finalInstance"] = await instance(setup.browser);
			evidence["requests"] = observed.requests;
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test.describe("default harness with a named instance", () => {
		test.use({
			harnessOptions: {
				managedOpenCode: true,
				opencodeBorrowIdleTimeoutMs: borrowIdleTimeoutMs,
				capabilityModels: claudeModels,
				restartProof: true,
			},
		});
		test("9cn3-default-named-instance: a stopped named OpenCode default prefills on page load", async ({
			page,
			harness,
		}, testInfo) => {
			const observed = await observeSessionRpc(page);
			const setup = await prepareDraft(harness, "opencode", "managed-test");
			const evidence: Record<string, unknown> = {
				case: "9cn3-default-named-instance",
				initialInstance: setup.initialInstance,
			};
			try {
				const picker = await openDraftPage(
					page,
					harness,
					setup.slug,
					"opencode",
				);
				await expect(picker).toHaveAttribute(
					"data-instance-id",
					"managed-test",
				);
				evidence["running"] = await waitForHealthy(
					setup.browser,
					"managed-test",
				);
				await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
				evidence["receipt"] = await sendShownPick(
					page,
					harness,
					picker,
					setup.slug,
					"9cn3-default-named-instance",
					observed,
					"managed-test",
				);
			} finally {
				evidence["finalInstance"] = await instance(
					setup.browser,
					"managed-test",
				);
				await writeGuardArtifact(testInfo, evidence);
			}
		});

		for (const catalogState of ["refreshed", "missing"] as const) {
			test(`9cn3-review-alias-${catalogState}: an alias-bound turn validates the named default catalog`, async ({
				harness,
			}, testInfo) => {
				const caseId = `9cn3-review-alias-${catalogState}`;
				const setup = await prepareDraft(harness, "claude", "managed-test");
				const { sessionId } = await Effect.runPromise(
					setup.browser.rpc.CreateSession({
						projectSlug: setup.slug,
						originId: caseId,
						permissionMode: "ask",
						instanceId: AccountIdSchema.make("opencode"),
						model: {
							providerId: "fake",
							modelId: "fake-model",
							variant: "",
							contextWindow: "",
						},
					}),
				);
				const rejectedModels = join(
					harness.configDir,
					"fake-opencode-reject-models",
				);
				const offered =
					catalogState === "refreshed" ? "fresh-model" : "fake-model";
				let browser = await harness.connect(sessionId, undefined, setup.slug);
				const evidence: Record<string, unknown> = { case: caseId, sessionId };
				try {
					evidence["before"] = readStoredState(harness, setup.slug, sessionId);
					expect(
						readStoredState(harness, setup.slug, sessionId).pick?.provider,
					).toBe("opencode");
					if (catalogState === "refreshed") {
						writeFileSync(
							join(harness.configDir, "fake-opencode-model-catalog.json"),
							JSON.stringify({
								all: [
									{
										id: "fake",
										name: "Refreshed default",
										models: {
											[offered]: {
												id: offered,
												name: offered,
												limit: { context: 128000, output: 4096 },
											},
										},
									},
								],
								default: { fake: offered },
								connected: ["fake"],
							}),
						);
						evidence["inventory"] = await Effect.runPromise(
							Stream.runHead(
								browser.rpc.SubscribeDraftModels({
									projectSlug: setup.slug,
									instanceId: "managed-test",
								}),
							),
						);
					} else {
						writeFileSync(rejectedModels, "test-only");
						await harness.terminate();
						await harness.restart();
						browser = await harness.connect(sessionId, undefined, setup.slug);
					}
					const beforePrompts = openCodePrompts(harness).length;
					await Effect.runPromise(
						browser.rpc["input.submit"]({
							sessionId,
							originId: caseId,
							inputId: `${caseId}-rejected`,
							delivery: "queue",
							text: `${caseId}-rejected`,
						}),
					);
					await expect
						.poll(() =>
							readStoredState(harness, setup.slug, sessionId).turnErrors.some(
								(event) => JSON.parse(event.data).code === "PICK_REJECTED",
							),
						)
						.toBe(true);
					evidence["rejected"] = readStoredState(
						harness,
						setup.slug,
						sessionId,
					);
					expect(openCodePrompts(harness)).toHaveLength(beforePrompts);
					rmSync(rejectedModels, { force: true });
					evidence["offeredInventory"] = await Effect.runPromise(
						Stream.runHead(
							browser.rpc.SubscribeDraftModels({
								projectSlug: setup.slug,
								instanceId: "managed-test",
							}),
						),
					);
					await Effect.runPromise(
						browser.rpc.SwitchModel({
							sessionId,
							providerId: "fake",
							modelId: offered,
						}),
					);
					await Effect.runPromise(
						browser.rpc["input.submit"]({
							sessionId,
							originId: caseId,
							inputId: `${caseId}-offered`,
							delivery: "queue",
							text: `${caseId}-offered`,
						}),
					);
					await expect
						.poll(() => openCodePrompts(harness).length)
						.toBe(beforePrompts + 1);
					const receipt = openCodePrompts(harness).at(-1);
					const targetInstance = await instance(browser, "managed-test");
					expect(receipt).toMatchObject({ pid: targetInstance?.pid });
					evidence["targetInstance"] = targetInstance;
					expect(JSON.parse(receipt?.body ?? "{}")).toMatchObject({
						model: { providerID: "fake", modelID: offered },
					});
					evidence["offeredReceipt"] = receipt;
					evidence["after"] = readStoredState(harness, setup.slug, sessionId);
				} finally {
					rmSync(rejectedModels, { force: true });
					evidence["finalState"] = readStoredState(
						harness,
						setup.slug,
						sessionId,
					);
					evidence["nativePrompts"] = openCodePrompts(harness);
					await writeGuardArtifact(testInfo, evidence);
				}
			});
		}
	});

	test("9cn3-review-bound-switches: named B changes model, effort and context while the default is stopped", async ({
		harness,
	}, testInfo) => {
		const setup = await prepareDraft(harness);
		const namedId = await addNamedInstance(setup, harness);
		writeFileSync(
			join(harness.configDir, "fake-opencode-named-model-catalog.json"),
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Named Provider",
						models: Object.fromEntries(
							["named-model", "named-next"].map((id) => [
								id,
								{
									id,
									name: id,
									limit: { context: 1000000, output: 4096 },
									variants: { low: {}, high: {} },
									contextWindowOptions: [
										{ value: "200k", label: "200k", isDefault: true },
										{ value: "1m", label: "1M" },
									],
								},
							]),
						),
					},
				],
				default: { fake: "named-model" },
				connected: ["fake"],
			}),
		);
		const evidence: Record<string, unknown> = {
			case: "9cn3-review-bound-switches",
			namedId,
		};
		try {
			const { sessionId } = await Effect.runPromise(
				setup.browser.rpc.CreateSession({
					projectSlug: setup.slug,
					originId: "9cn3-review-bound-switches",
					permissionMode: "ask",
					instanceId: AccountIdSchema.make(namedId),
					model: {
						providerId: "fake",
						modelId: "named-model",
						variant: "low",
						contextWindow: "200k",
					},
				}),
			);
			const browser = await harness.connect(sessionId, undefined, setup.slug);
			expect((await instance(browser))?.status).toBe("stopped");
			evidence["model"] = await Effect.runPromise(
				browser.rpc.SwitchModel({
					sessionId,
					providerId: "fake",
					modelId: "named-next",
				}),
			);
			evidence["effort"] = await Effect.runPromise(
				browser.rpc.SwitchVariant({
					sessionId,
					variant: "high",
				}),
			);
			evidence["context"] = await Effect.runPromise(
				browser.rpc.SwitchContextWindow({
					sessionId,
					contextWindow: "1m",
				}),
			);
			const before = readStoredState(harness, setup.slug, sessionId);
			expect(before.pick).toMatchObject({
				provider: namedId,
				model_id: "named-next",
				model_provider: "fake",
				variant: "high",
				context_window: "1m",
			});
			evidence["beforeTurn"] = before;
			const promptCount = openCodePrompts(harness).length;
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: "9cn3-review-bound-switches",
					inputId: "9cn3-review-bound-switches",
					delivery: "queue",
					text: "9cn3-review-bound-switches",
				}),
			);
			await expect
				.poll(() => openCodePrompts(harness).length)
				.toBe(promptCount + 1);
			const receipt = openCodePrompts(harness).at(-1);
			const targetInstance = await instance(browser, namedId);
			expect(receipt).toMatchObject({ pid: targetInstance?.pid });
			evidence["targetInstance"] = targetInstance;
			expect(JSON.parse(receipt?.body ?? "{}")).toMatchObject({
				model: { providerID: "fake", modelID: "named-next" },
				variant: "high",
			});
			evidence["receipt"] = receipt;
			evidence["afterTurn"] = readStoredState(harness, setup.slug, sessionId);
			expect(evidence["afterTurn"]).toMatchObject({
				pick: before.pick,
				turnErrors: [],
			});
			expect((await instance(browser))?.status).toBe("stopped");
		} finally {
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test.describe("cancelled promoted startup", () => {
		test.use({
			harnessOptions: {
				managedOpenCode: true,
				managedOpenCodeId: "opencode",
				opencodeBorrowIdleTimeoutMs: 30_000,
				capabilityModels: claudeModels,
				restartProof: true,
			},
		});
		test("9cn3-review-orphan-start: cancelling inventory and ordinary use settles under ordinary idle policy", async ({
			harness,
		}, testInfo) => {
			const ordinaryIdleTimeoutMs = 1_500;
			await harness.terminate();
			await harness.restart({ opencodeIdleTimeoutMs: ordinaryIdleTimeoutMs });
			const setup = await prepareDraft(harness);
			const healthGate = join(harness.configDir, "fake-opencode-hold-health");
			const evidence: Record<string, unknown> = {
				case: "9cn3-review-orphan-start",
				ordinaryIdleTimeoutMs,
				borrowIdleTimeoutMs: 30_000,
			};
			writeFileSync(healthGate, "test-only");
			const borrow = Effect.runFork(
				Stream.runDrain(
					setup.browser.rpc.SubscribeDraftModels({
						projectSlug: setup.slug,
						instanceId: "opencode",
					}),
				),
			);
			let ordinary: ReturnType<typeof Effect.runFork> | undefined;
			try {
				await expect
					.poll(async () => (await instance(setup.browser))?.status)
					.toBe("starting");
				ordinary = Effect.runFork(
					setup.browser.rpc.SetHarnessDefault({
						projectSlug: setup.slug,
						harness: "opencode",
						providerId: "fake",
						modelId: "fake-model",
						effort: "",
						contextWindow: "",
					}),
				);
				const ordinaryFiber = ordinary;
				// An ordered request on this same RPC client fences handler delivery;
				// health stays held, so neither use can complete its shared start.
				await setup.browser.getModels("opencode");
				expect(
					Option.isNone(
						await Effect.runPromise(
							Effect.sync(() => Option.fromUndefinedOr(borrow.pollUnsafe())),
						),
					),
				).toBe(true);
				expect(
					Option.isNone(
						await Effect.runPromise(
							Effect.sync(() =>
								Option.fromUndefinedOr(ordinaryFiber.pollUnsafe()),
							),
						),
					),
				).toBe(true);
				await Effect.runPromise(Fiber.interrupt(ordinary));
				await Effect.runPromise(Fiber.interrupt(borrow));
				await setup.browser.instances();
				evidence["afterCancellation"] = await instance(setup.browser);
				expect((await instance(setup.browser))?.status).toBe("starting");
				rmSync(healthGate);
				const healthy = await waitForHealthy(setup.browser);
				evidence["healthy"] = healthy;
				await expect
					.poll(async () => (await instance(setup.browser))?.status, {
						timeout: 15_000,
					})
					.toBe("stopped");
				await expect.poll(() => isProcessAlive(healthy?.pid ?? 0)).toBe(false);
				evidence["stopped"] = await instance(setup.browser);
			} finally {
				rmSync(healthGate, { force: true });
				if (ordinary) await Effect.runPromise(Fiber.interrupt(ordinary));
				await Effect.runPromise(Fiber.interrupt(borrow));
				await writeGuardArtifact(testInfo, evidence);
			}
		});
	});

	test("9cn3-two-browsers: another browser holds the borrow until it disconnects", async ({
		page,
		harness,
	}, testInfo) => {
		const setup = await prepareDraft(harness);
		const otherPage = await page.context().newPage();
		const evidence: Record<string, unknown> = {
			case: "9cn3-two-browsers",
			bead: "conduit-test-9cn3",
			borrowIdleTimeoutMs,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			await selectDraftHarness(page, picker, "opencode");
			const borrowed = await waitForHealthy(setup.browser);
			evidence["borrowed"] = borrowed;
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			const otherPicker = await openDraftPage(otherPage, harness, setup.slug);
			await selectDraftHarness(otherPage, otherPicker, "opencode");
			await expect(otherPicker).toHaveAttribute(
				"data-shown-model",
				model.modelID,
			);
			await selectDraftHarness(page, picker, "claude");
			evidence["samplesWithOtherBrowser"] = await staysHealthy(
				setup.browser,
				borrowed?.pid,
			);
			await otherPage.close();
			await expect
				.poll(async () => (await instance(setup.browser))?.status, {
					timeout: 20_000,
				})
				.toBe("stopped");
			await expect.poll(() => isProcessAlive(borrowed?.pid ?? 0)).toBe(false);
			evidence["unbound"] = await unboundState(setup);
		} finally {
			if (!otherPage.isClosed()) await otherPage.close();
			evidence["finalInstance"] = await instance(setup.browser);
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("9cn3-named-instance: a draft borrows and releases the selected OpenCode instance id", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const setup = await prepareDraft(harness);
		const namedId = await addNamedInstance(setup, harness);
		expect(namedId).not.toBe("opencode");
		const evidence: Record<string, unknown> = {
			case: "9cn3-named-instance",
			bead: "conduit-test-9cn3",
			namedId,
			borrowIdleTimeoutMs,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			const claudeBefore = await readShown(picker);
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-harness-opencode").click();
			await page.getByTestId(`picker-account-${namedId}`).click();
			await closePicker(page);
			await expect(picker).toHaveAttribute("data-instance-id", namedId);
			const borrowed = await waitForHealthy(setup.browser, namedId);
			evidence["borrowed"] = borrowed;
			await pickModel(page, picker, namedModel);
			await expect(picker).toHaveAttribute(
				"data-shown-model",
				namedModel.modelID,
			);
			evidence["shown"] = await readShown(picker);
			const unbound = await unboundState(setup);
			evidence["unbound"] = unbound;
			expect(unbound.sessions).toEqual([]);
			await selectDraftHarness(page, picker, "claude");
			await expectShown(picker, claudeBefore);
			await expect
				.poll(async () => (await instance(setup.browser, namedId))?.status, {
					timeout: 20_000,
				})
				.toBe("stopped");
			await expect.poll(() => isProcessAlive(borrowed?.pid ?? 0)).toBe(false);
			await openPickerRoot(page, picker);
			await page.getByTestId("picker-harness-opencode").click();
			await page.getByTestId(`picker-account-${namedId}`).click();
			await closePicker(page);
			await waitForHealthy(setup.browser, namedId);
			await pickModel(page, picker, namedModel);
			evidence["receipt"] = await sendShownPick(
				page,
				harness,
				picker,
				setup.slug,
				"9cn3-named-instance",
				observed,
				namedId,
			);
			await expect(picker).toHaveAttribute("data-instance-id", namedId);
			await expect(picker).toHaveAttribute(
				"data-shown-model",
				namedModel.modelID,
			);
		} finally {
			evidence["finalNamedInstance"] = await instance(setup.browser, namedId);
			evidence["finalDefaultInstance"] = await instance(setup.browser);
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("9cn3-catalog-isolation: another draft catalog does not reject a bound instance turn", async ({
		page,
		harness,
	}, testInfo) => {
		const observed = await observeSessionRpc(page);
		const setup = await prepareDraft(harness);
		const namedId = await addNamedInstance(setup, harness);
		const otherPage = await page.context().newPage();
		const evidence: Record<string, unknown> = {
			case: "9cn3-catalog-isolation",
			namedId,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			await selectDraftHarness(page, picker, "opencode");
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			evidence["firstTurn"] = await sendShownPick(
				page,
				harness,
				picker,
				setup.slug,
				"9cn3-isolation-before",
				observed,
			);
			const otherPicker = await openDraftPage(otherPage, harness, setup.slug);
			await openPickerRoot(otherPage, otherPicker);
			await otherPage.getByTestId("picker-harness-opencode").click();
			await otherPage.getByTestId(`picker-account-${namedId}`).click();
			await closePicker(otherPage);
			await waitForHealthy(setup.browser, namedId);
			await pickModel(otherPage, otherPicker, namedModel);
			evidence["otherDraft"] = await readShown(otherPicker);
			await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
			await new AppPage(page).sendMessage("9cn3-isolation-after");
			await expect.poll(() => openCodePrompts(harness).length).toBe(2);
			const receipt = openCodePrompts(harness)[1];
			const sent: unknown = JSON.parse(receipt?.body ?? "{}");
			expect(sent).toMatchObject({ model });
			evidence["secondTurn"] = receipt;
		} finally {
			await otherPage.close();
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("9cn3-reconnect-failure: a disconnected running instance ends loading with an error", async ({
		page,
		harness,
	}, testInfo) => {
		const setup = await prepareDraft(harness);
		await setup.browser.startInstance("opencode");
		const running = await waitForHealthy(setup.browser);
		const blocked = join(harness.configDir, "fake-opencode-reject-events");
		writeFileSync(blocked, "test-only");
		await harness.closeOpenCodeStreams();
		const evidence: Record<string, unknown> = {
			case: "9cn3-reconnect-failure",
			running,
		};
		try {
			const picker = await openDraftPage(page, harness, setup.slug);
			await selectDraftHarness(page, picker, "opencode");
			const app = new AppPage(page);
			await app.input.fill("9cn3-reconnect-failure");
			await expect(
				page.getByText(/OpenCode model discovery failed:/).first(),
			).toBeVisible({ timeout: 20_000 });
			await expect(picker).toContainText("Select model");
			await expect(picker).toHaveAttribute("data-shown-model", "");
			await expect(app.sendBtn).toBeDisabled();
			evidence["afterFailure"] = await readShown(picker);
			await selectDraftHarness(page, picker, "claude");
			evidence["samples"] = await staysHealthy(setup.browser, running?.pid);
		} finally {
			rmSync(blocked, { force: true });
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	test("merge-cold-inventory-retry: a failed first inventory keeps the picker mounted through retries", async ({
		page,
		harness,
	}, testInfo) => {
		const setup = await prepareDraft(harness, "opencode");
		const blocked = join(harness.configDir, "fake-opencode-reject-models");
		writeFileSync(blocked, "test-only");
		let identityReplies = 0;
		const evidence: Record<string, unknown> = {
			case: "merge-cold-inventory-retry",
		};
		try {
			await editRpc(page, (frame, request) => {
				if (request?.tag === "GetModels" && frame._tag === "Exit") {
					identityReplies++;
					// Inventory needs the resolved instance identity before starting.
					// Supply that metadata without supplying a successful catalog.
					return editModelInventories(frame, (response) => {
						const {
							active: _active,
							modelExecution: _execution,
							...metadata
						} = response;
						return {
							...metadata,
							providers: [],
							variant: { variant: "", variants: [] },
							contextWindow: { contextWindow: "", options: [] },
						};
					});
				}
				return frame;
			});
			const app = new AppPage(page);
			await app.goto(
				`${harness.baseUrl}/new?p=${encodeURIComponent(setup.slug)}`,
			);
			await expect(
				page.getByText(/OpenCode model discovery failed:/).first(),
			).toBeVisible({ timeout: 20_000 });
			await expect.poll(() => identityReplies).toBeGreaterThan(0);
			const picker = page.locator(pickerSelector);
			await expect(picker).toBeVisible();
			await expect(picker).toHaveAttribute("data-shown-model", "");
			await app.input.fill("merge-cold-inventory-retry");
			await expect(app.sendBtn).toBeDisabled();
			await openPickerRoot(page, picker);
			await expect(page.getByTestId("model-picker")).toBeVisible();
			await page.getByTestId("picker-harness-claude").click();
			await expect(picker).toHaveAttribute("data-shown-harness", "claude");
			await expect(page.getByTestId("model-picker")).toBeVisible();
			evidence["shownAfterSwitch"] = await readShown(picker);
			evidence["identityReplies"] = identityReplies;
			evidence["pickerVisible"] = await page
				.getByTestId("model-picker")
				.isVisible();
		} finally {
			rmSync(blocked, { force: true });
			await writeGuardArtifact(testInfo, evidence);
		}
	});

	for (const resource of ["events", "models"] as const)
		test(`9cn3-discovery-${resource}-failure: failed discovery ends loading and the picker retries`, async ({
			page,
			harness,
		}, testInfo) => {
			const setup = await prepareDraft(harness);
			const blocked = join(
				harness.configDir,
				`fake-opencode-reject-${resource}`,
			);
			writeFileSync(blocked, "test-only");
			const evidence: Record<string, unknown> = {
				case: `9cn3-discovery-${resource}-failure`,
			};
			try {
				const picker = await openDraftPage(page, harness, setup.slug);
				await selectDraftHarness(page, picker, "opencode");
				const app = new AppPage(page);
				await app.input.fill("9cn3-discovery-failure");
				await expect(app.sendBtn).toBeDisabled();
				await expect(
					page.getByText(/OpenCode model discovery failed:/).first(),
				).toBeVisible({ timeout: 20_000 });
				await expect(picker).toContainText("Select model");
				await expect(picker).toHaveAttribute("data-shown-model", "");
				await expect(app.sendBtn).toBeDisabled();
				evidence["failed"] = {
					shown: await readShown(picker),
					instance: await instance(setup.browser),
				};
				await expect
					.poll(async () => (await instance(setup.browser))?.status, {
						timeout: 20_000,
					})
					.toBe("stopped");
				evidence["releasedAfterFailure"] = await instance(setup.browser);
				rmSync(blocked);
				await openPickerRoot(page, picker);
				await page.getByTestId("picker-row-model").click();
				await expect(page.getByTestId("model-picker-list")).not.toContainText(
					"No models available",
				);
				await expect(picker).toHaveAttribute("data-shown-model", model.modelID);
				await expect(app.sendBtn).toBeEnabled();
				evidence["retried"] = await readShown(picker);
			} finally {
				rmSync(blocked, { force: true });
				await writeGuardArtifact(testInfo, evidence);
			}
		});
});

test.describe("runtime and stopped OpenCode picks", () => {
	test.use({
		harnessOptions: {
			managedOpenCode: true,
			capabilityModels: claudeModels,
			restartProof: true,
			relaySettings: {
				harnessDefaults: {
					opencode: {
						providerId: "fake",
						modelId: "fake-model",
						contextWindow: "",
					},
				},
				defaultVariants: { "fake/fake-model": "high" },
			},
		},
	});

	async function startManagedProject(harness: ProcessHarness) {
		const directory = mkdtempSync(join(harness.root, "native-pick-project-"));
		writeFileSync(
			join(harness.configDir, "fake-opencode-model-catalog.json"),
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Fake Provider",
						models: Object.fromEntries(
							["fake-model", "fake-source"].map((id) => [
								id,
								{
									id,
									name: id,
									variants: { high: {} },
									limit: { context: 128000, output: 4096 },
								},
							]),
						),
					},
				],
				default: { fake: "fake-model" },
				connected: ["fake"],
			}),
		);
		const browser = await harness.connect();
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory] }),
		);
		if (!slug) throw new Error("SaveProject did not return a slug");
		const { instances } = await browser.instances();
		const instanceId = instances.find(
			(instance) => instance.managed && instance.driver === "opencode",
		)?.id;
		if (!instanceId) throw new Error("No managed OpenCode fixture instance");
		await browser.startInstance(instanceId);
		return { browser, slug, directory, instanceId };
	}

	test("native-opencode-pick: native sessions receive a pick before their first conduit turn", async ({
		harness,
	}, testInfo) => {
		const caseId = "native-opencode-pick";
		const { browser, slug, directory, instanceId } =
			await startManagedProject(harness);
		const source = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug: slug,
				originId: caseId,
				instanceId: AccountIdSchema.make(instanceId),
				model: {
					providerId: "fake",
					modelId: "fake-source",
					variant: "",
					contextWindow: "",
				},
			}),
		);
		const instance = Either.getOrThrow(
			loadDaemonConfigResult(harness.configDir),
		).instances?.find(({ id }) => id === instanceId);
		if (!instance?.port) throw new Error("No running OpenCode fixture port");
		const runtimeInstance = {
			id: instanceId,
			pid: instance.pid,
			port: instance.port,
		};
		const sourcePick = readStoredState(harness, slug, source.sessionId);
		const observations: Readonly<Record<string, unknown>>[] = [];
		try {
			for (const parentId of [undefined, source.sessionId]) {
				const response = await fetch(
					`http://127.0.0.1:${instance.port}/session?directory=${encodeURIComponent(directory)}`,
					{
						method: "POST",
						headers: {
							Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							title: caseId,
							...(parentId ? { parentID: parentId } : {}),
						}),
						signal: AbortSignal.timeout(10_000),
					},
				);
				expect(response.ok).toBe(true);
				const native = (await response.json()) as { id: string };
				const expected = {
					provider: "opencode",
					model_id: parentId ? "fake-source" : "fake-model",
					model_provider: "fake",
					variant: parentId ? "" : "high",
					context_window: "",
				};
				const observation: Record<string, unknown> = {
					native,
					parentId: parentId ?? null,
					expected,
				};
				observations.push(observation);
				let firstVisible:
					| (StoredPickRow & {
							parent_id: string | null;
							pick_event_count: number;
							created_event_count: number;
							bound_provider: string | null;
					  })
					| undefined;
				const db = new Database(harness.daemonStorePath(), {
					readonly: true,
				});
				try {
					await expect
						.poll(
							() => {
								firstVisible = db
									.prepare<[string], NonNullable<typeof firstVisible>>(
										`SELECT provider, model_id, model_provider, variant, context_window, parent_id,
							 (SELECT provider FROM session_providers sp WHERE sp.session_id = s.id AND sp.status = 'active'
							 ORDER BY activated_at DESC, id DESC LIMIT 1) AS bound_provider,
							 (SELECT count(*) FROM events e WHERE e.session_id = s.id AND e.type IN
							 ('session.model_changed', 'session.variant_changed', 'session.context_window_changed')) AS pick_event_count,
							 (SELECT count(*) FROM events e WHERE e.session_id = s.id AND e.type = 'session.created') AS created_event_count
							 FROM sessions s WHERE id = ?`,
									)
									.get(native.id);
								return firstVisible !== undefined;
							},
							{ timeout: 15_000 },
						)
						.toBe(true);
				} finally {
					db.close();
				}
				const created = readStoredState(harness, slug, native.id);
				observation["firstVisible"] = firstVisible;
				observation["created"] = created;
				const promptsBefore = openCodePrompts(harness).length;
				const prompt = `${caseId}-${parentId ? "child" : "external"}`;
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId: native.id,
						inputId: prompt,
						originId: caseId,
						delivery: "queue",
						text: prompt,
					}),
				);
				let prompts = openCodePrompts(harness).slice(promptsBefore);
				try {
					await expect
						.poll(
							() => {
								prompts = openCodePrompts(harness).slice(promptsBefore);
								return prompts.length;
							},
							{ timeout: 15_000 },
						)
						.toBe(1);
				} finally {
					observation["prompts"] = prompts;
					observation["after"] = readStoredState(harness, slug, native.id);
					const commandDb = new Database(harness.daemonStorePath(), {
						readonly: true,
					});
					try {
						const command = commandDb
							.prepare<[string], { payload_json: string }>(
								`SELECT payload_json FROM provider_command_outbox
								 WHERE session_id = ? AND effect_type = 'send_turn'
								 ORDER BY request_sequence DESC LIMIT 1`,
							)
							.get(native.id);
						observation["dispatched"] = command
							? JSON.parse(command.payload_json)
							: null;
					} finally {
						commandDb.close();
					}
				}
				expect(firstVisible).toMatchObject({
					...expected,
					parent_id: parentId ?? null,
					pick_event_count: 3,
					created_event_count: 1,
					bound_provider: "opencode",
				});
				expect(created.pick).toEqual(expected);
				expect(typeof runtimeInstance.pid).toBe("number");
				expect(prompts[0]?.pid).toBe(runtimeInstance.pid);
				expect(observation["dispatched"]).toMatchObject({
					model: { providerId: "fake", modelId: expected.model_id },
					variant: expected.variant,
					contextWindow: expected.context_window,
				});
				const sent = JSON.parse(prompts[0]?.body ?? "{}") as {
					model?: { providerID: string; modelID: string };
					variant?: string;
				};
				expect(sent).toMatchObject({
					model: { providerID: "fake", modelID: expected.model_id },
				});
				expect(sent.variant ?? "").toBe(expected.variant);
			}
		} finally {
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.4",
				sourceSessionId: source.sessionId,
				sourcePick,
				runtimeInstance,
				restartCount: 0,
				observations,
			});
		}
		expect(sourcePick.pick).toEqual({
			provider: instanceId,
			model_id: "fake-source",
			model_provider: "fake",
			variant: "",
			context_window: "",
		});
		expect(sourcePick.pickEvents).toHaveLength(3);
	});

	test("legacy-stopped-opencode-backfill: restart leaves a stopped instance and unresolved pick alone", async ({
		harness,
	}, testInfo) => {
		test.setTimeout(240_000);
		const caseId = "legacy-stopped-opencode-backfill";
		const { browser, slug, instanceId } = await startManagedProject(harness);
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug: slug,
				originId: caseId,
				instanceId: AccountIdSchema.make(instanceId),
				model: {
					providerId: "fake",
					modelId: "fake-model",
					variant: "high",
					contextWindow: "",
				},
			}),
		);
		await browser.stopInstance(instanceId);
		const stopped = await browser.instanceStatus(instanceId);
		await expect
			.poll(() => harness.ownedOpenCodePids().filter(isProcessAlive))
			.toEqual([]);
		const pidsBefore = harness.ownedOpenCodePids();
		const requestsBefore = harness.opencodeRequests().length;
		await browser.close();
		await harness.terminate();
		const db = new Database(harness.daemonStorePath());
		try {
			db.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
			 variant = NULL, context_window = NULL WHERE id = ?`).run(sessionId);
		} finally {
			db.close();
		}
		const legacy = readStoredState(harness, slug, sessionId);
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 30_000,
		});
		const restartedBrowser = await harness.connect();
		const afterStatus = await restartedBrowser.instanceStatus(instanceId);
		const after = readStoredState(harness, slug, sessionId);
		const pidsAfter = harness.ownedOpenCodePids();
		await writeGuardArtifact(testInfo, {
			case: caseId,
			bead: "conduit-test-fmg0.4",
			stopped,
			afterStatus,
			legacy,
			after,
			pidsBefore,
			pidsAfter,
			remainingPids: pidsAfter.filter(isProcessAlive),
			requestsBefore,
			requestsAfter: harness.opencodeRequests().length,
		});
		expect(stopped.instance.status).toBe("stopped");
		expect(afterStatus.instance.status).toBe("stopped");
		expect(after.pick).toEqual(legacy.pick);
		expect(after.pick?.model_id).toBeNull();
		expect(after.pickEvents).toEqual(legacy.pickEvents);
		expect(pidsAfter).toEqual(pidsBefore);
		expect(pidsAfter.filter(isProcessAlive)).toEqual([]);
		expect(harness.opencodeRequests()).toHaveLength(requestsBefore);
	});

	test("legacy-stopped-opencode-partial-pick: partial picks complete without discovery on the first restart", async ({
		harness,
	}, testInfo) => {
		test.setTimeout(240_000);
		const caseId = "legacy-stopped-opencode-partial-pick";
		const { browser, slug, instanceId } = await startManagedProject(harness);
		const samples: {
			sessionId: string;
			variant: string | null;
			contextWindow: string | null;
		}[] = [];
		for (const empty of ["neither", "effort", "context"] as const) {
			const { sessionId } = await Effect.runPromise(
				browser.rpc.CreateSession({
					permissionMode: "ask",
					projectSlug: slug,
					originId: `${caseId}-${empty}`,
					instanceId: AccountIdSchema.make(instanceId),
					model: {
						providerId: "fake",
						modelId: "fake-source",
						variant: "high",
						contextWindow: "",
					},
				}),
			);
			samples.push({
				sessionId,
				variant: empty === "effort" ? "" : null,
				contextWindow: empty === "context" ? "" : null,
			});
		}
		await browser.stopInstance(instanceId);
		await expect
			.poll(() => harness.ownedOpenCodePids().filter(isProcessAlive))
			.toEqual([]);
		const pidsBefore = harness.ownedOpenCodePids();
		const requestsBefore = harness.opencodeRequests().length;
		await browser.close();
		await harness.terminate();
		const db = new Database(harness.daemonStorePath());
		let executedTurns: number;
		try {
			executedTurns =
				db
					.prepare<[string], { count: number }>(
						"SELECT count(*) AS count FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? AND t.started_at IS NOT NULL",
					)
					.get(slug)?.count ?? 0;
			for (const sample of samples)
				db.prepare(
					"UPDATE sessions SET variant = ?, context_window = ? WHERE id = ?",
				).run(sample.variant, sample.contextWindow, sample.sessionId);
			// Deliberately reset the daemon-wide singleton: these isolated fixtures
			// exercise the first store-wide pick repair across all registered projects.
			db.exec(
				"UPDATE session_pick_backfill_state SET initialized = 0 WHERE singleton = 1",
			);
		} finally {
			db.close();
		}
		const legacy = samples.map((sample) =>
			readStoredState(harness, slug, sample.sessionId),
		);
		const firstSample = samples[0];
		if (!firstSample) throw new Error("No partial session sample");
		const restorations: {
			picks: ReturnType<typeof readStoredState>[];
			status: Awaited<ReturnType<ProcessBrowser["instanceStatus"]>>;
			pids: number[];
			requests: number;
		}[] = [];
		try {
			for (let restart = 0; restart < 2; restart++) {
				await harness.restart({
					startupTimeoutMs: 60_000,
					runnerStartupTimeoutMs: 30_000,
				});
				const restartedBrowser = await harness.connect();
				// Relays start lazily. A store-only read mounts this project without discovery.
				await Effect.runPromise(
					restartedBrowser.rpc.LoadMoreHistory({
						sessionId: firstSample.sessionId,
					}),
				);
				restorations.push({
					picks: samples.map((sample) =>
						readStoredState(harness, slug, sample.sessionId),
					),
					status: await restartedBrowser.instanceStatus(instanceId),
					pids: harness.ownedOpenCodePids(),
					requests: harness.opencodeRequests().length,
				});
				await restartedBrowser.close();
				if (restart === 0) await harness.terminate();
			}
		} finally {
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.4",
				samples,
				executedTurns,
				legacy,
				pidsBefore,
				requestsBefore,
				relayStartupRequest: {
					method: "LoadMoreHistory",
					projectSlug: slug,
					sessionId: firstSample.sessionId,
				},
				restorations,
				configuredInstances: Either.getOrThrow(
					loadDaemonConfigResult(harness.configDir),
				).instances?.map(({ id, driver }) => ({ id, driver })),
			});
		}
		expect(executedTurns).toBe(0);
		for (const restored of restorations) {
			expect(restored.status.instance.status).toBe("stopped");
			expect(restored.pids).toEqual(pidsBefore);
			expect(restored.pids.filter(isProcessAlive)).toEqual([]);
			expect(restored.requests).toBe(requestsBefore);
			for (const [index, sample] of samples.entries()) {
				const completed = restored.picks[index];
				expect(completed?.pick).toEqual({
					provider: instanceId,
					model_id: "fake-source",
					model_provider: "fake",
					variant: "",
					context_window: "",
				});
				expect(
					completed?.pickEvents
						.slice(legacy[index]?.pickEvents.length)
						.map((event) => event.type),
				).toEqual([
					...(sample.variant === null ? ["session.variant_changed"] : []),
					...(sample.contextWindow === null
						? ["session.context_window_changed"]
						: []),
				]);
			}
		}
		expect(restorations[1]?.picks).toEqual(restorations[0]?.picks);
	});
});

for (const rejection of [
	"uncatalogued",
	"missing",
	"effort",
	"context",
	"provider",
] as const) {
	const caseId = {
		uncatalogued: "reject-turn-no-model-event",
		missing: "pick-required-turn",
		effort: "pick-required-effort",
		context: "pick-required-context",
		provider: "pick-required-provider",
	}[rejection];
	test(`${caseId}: rejected turn writes no model change or provider prompt`, async ({
		page,
		harness,
	}, testInfo) => {
		const { browser, slug, sessionId } = await createStoredPickSession(
			page,
			harness,
			caseId,
		);
		await Effect.runPromise(browser.rpc.GetModels({ sessionId }));
		const before = readStoredState(harness, slug, sessionId);
		const receiptsBefore = enqueues(harness, true).length;
		const db = new Database(harness.daemonStorePath());
		try {
			const changed =
				rejection === "uncatalogued"
					? db
							.prepare("UPDATE sessions SET model_id = ? WHERE id = ?")
							.run("not-in-catalog", sessionId)
					: rejection === "missing"
						? db
								.prepare(`UPDATE sessions SET model_id = NULL, model_provider = NULL,
				variant = NULL, context_window = NULL WHERE id = ?`)
								.run(sessionId)
						: db
								.prepare(
									`UPDATE sessions SET ${
										{
											effort: "variant",
											context: "context_window",
											provider: "model_provider",
										}[rejection]
									} = NULL WHERE id = ?`,
								)
								.run(sessionId);
			expect(changed.changes).toBe(1);
		} finally {
			db.close();
		}
		const submit = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				inputId: caseId,
				originId: "pick-guard",
				delivery: "queue",
				text: caseId,
			}),
		);
		let after = readStoredState(harness, slug, sessionId);
		let receiptsAfter: number | undefined;
		let repaired: ReturnType<typeof readStoredState> | undefined;
		let selectedVariant: string | undefined;
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
			receiptsAfter = enqueues(harness, true).length;
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
			expect(receiptsAfter).toBe(receiptsBefore);
			if (
				rejection === "effort" ||
				rejection === "context" ||
				rejection === "provider"
			) {
				const selected = await Effect.runPromise(
					browser.rpc.SwitchModel({
						sessionId,
						modelId: "sonnet",
						providerId: "claude",
					}),
				);
				selectedVariant = selected.variant;
				repaired = readStoredState(harness, slug, sessionId);
				expect(repaired.pick).toMatchObject({
					model_id: "sonnet",
					model_provider: "claude",
					variant: selectedVariant,
					context_window: rejection === "context" ? "" : "200k",
				});
			}
		} finally {
			receiptsAfter ??= enqueues(harness, true).length;
			await writeGuardArtifact(testInfo, {
				case: caseId,
				bead: "conduit-test-fmg0.4",
				expectedCode:
					rejection === "uncatalogued" ? "PICK_REJECTED" : "PICK_REQUIRED",
				submit,
				before,
				after,
				receiptsBefore,
				receiptsAfter,
				repaired,
				selectedVariant,
			});
		}
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
	const firstPrompt = "merge-side-first: Prove the source pick is inherited";
	const sideRequest = {
		sessionId: sessionId,
		title: "Prove the source pick is inherited",
		inputId: crypto.randomUUID(),
		text: firstPrompt,
	};
	const side = await Effect.runPromise(
		browser.rpc.StartSideThread(sideRequest),
	);
	const retries = await Promise.all([
		Effect.runPromise(browser.rpc.StartSideThread(sideRequest)),
		Effect.runPromise(browser.rpc.StartSideThread(sideRequest)),
	]);
	await expect
		.poll(
			() =>
				enqueues(harness, true).filter((mark) =>
					mark.prompt.includes(firstPrompt),
				).length,
		)
		.toBe(1);
	const firstReceipt = enqueues(harness, true).find((mark) =>
		mark.prompt.includes(firstPrompt),
	);
	expect(firstReceipt?.liveOptions.model).toBe("sonnet[1m]");
	expect(firstReceipt?.liveOptions.effort).toBe("high");
	expect(retries.map((retry) => retry.sessionId)).toEqual([
		side.sessionId,
		side.sessionId,
	]);
	const created = readStoredState(harness, slug, side.sessionId);
	expect(created.sessionCount).toBe(source.sessionCount + 1);
	const models = await Effect.runPromise(
		browser.rpc.GetModels({ sessionId: side.sessionId }),
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
		sideRequest,
		retries,
		firstReceipt,
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
	const db = new Database(harness.daemonStorePath());
	try {
		db.prepare("UPDATE sessions SET context_window = NULL WHERE id = ?").run(
			sessionId,
		);
		const rejected = await Effect.runPromise(
			Effect.result(
				browser.rpc.StartSideThread({
					...sideRequest,
					inputId: crypto.randomUUID(),
					text: "merge-side-missing-source-pick",
				}),
			),
		);
		const afterRejected = readStoredState(harness, slug, sessionId);
		await writeGuardArtifact(testInfo, {
			case: "server-side-thread-pick",
			sent,
			source,
			created,
			reported,
			sideRequest,
			retries,
			firstReceipt,
			rejected,
			afterRejected,
		});
		expect(rejected._tag).toBe("Failure");
		expect(afterRejected.sessionCount).toBe(created.sessionCount);
		expect(
			enqueues(harness, true).filter((mark) =>
				mark.prompt.includes("merge-side-missing-source-pick"),
			),
		).toHaveLength(0);
	} finally {
		db.prepare("UPDATE sessions SET context_window = '1m' WHERE id = ?").run(
			sessionId,
		);
		db.close();
	}
});

async function assertPickRejected(
	guard: GuardCase,
	result: Either.Result<unknown, unknown>,
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
	const error = result._tag === "Failure" ? result.failure : undefined;
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
			result._tag === "Failure" && error instanceof WsRpcError
				? {
						_tag: "Failure",
						error: { _tag: error._tag, message: error.message },
					}
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
							permissionMode: "ask",
							projectSlug: slug,
							originId: `${caseId}-setup`,
							instanceId: AccountIdSchema.make(driver),
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
					permissionMode: "ask" as const,
					projectSlug: slug,
					originId: caseId,
					instanceId: AccountIdSchema.make(driver),
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
				const result = await Effect.runPromise(Effect.result(call));
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

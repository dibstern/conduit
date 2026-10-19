import type { Page, TestInfo } from "@playwright/test";
import { Stream } from "effect";
import { AccountUnroutable } from "../../../src/lib/contracts/limit-recovery.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { singleInstanceList } from "../fixtures/mockup-state.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Action failures reach the toast without navigating, deleting a row,
// applying a failed read mark, clearing a draft, or hiding a cut-off message.
// Failed route placement keeps the prior session cached for Back to restore.
// A dropped socket must settle the action with its fallback, never a server reason.
test.use({ viewport: { width: 1440, height: 900 } });

const projectSlug = "e2e-replay";
const seed = "session-error-seed";
const target = "session-error-target";
const draft = "Keep this draft";
const refused = "The server refused this session change.";
const unroutable = new AccountUnroutable({
	ref: { _tag: "Id", id: "missing-session-account" },
});
const refuse = () => {
	throw new WsRpcError({ message: refused });
};

async function openSession(
	page: Page,
	baseUrl: string,
	stubs: StubTable,
	targetState: Partial<SessionInfo> = {},
	seedState: Partial<SessionInfo> = {},
) {
	const rows: SessionInfo[] = [
		{
			id: seed,
			accountId: null,
			title: "Current session",
			status: "idle",
			projectSlug,
			updatedAt: Date.now(),
			...seedState,
		},
		{
			id: target,
			accountId: null,
			title: "Other session",
			status: "idle",
			projectSlug,
			updatedAt: Date.now() - 1_000,
			...targetState,
		},
	];
	const rpc = await mockWsRpc(page, {
		streams: {
			SubscribeInputDraft: () => [{ _tag: "synchronized", text: draft }],
		},
		stubs: {
			ResolveSession: () => ({ projectSlug }),
			ViewSession: () => ({ ok: true }),
			InspectSessionWorktrees: () => ({
				worktrees: [],
				removeWorktrees: false,
				onDelete: "ask",
			}),
			ListDaemonSessions: () => ({
				sessions: rows,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			...stubs,
			AttachProject: () => ({ projectSlug, sessionSlug: projectSlug }),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: projectSlug,
						title: projectSlug,
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: projectSlug,
			},
			{ type: "shell_snapshot", roots: true, sessions: rows },
		],
		responses: new Map(),
	});
	rpc.setDetailRows(seed, [
		...detailRowsOf({
			id: "session-error-question",
			role: "user",
			time: { created: 1 },
			parts: [{ id: "question-text", type: "text", text: "Existing question" }],
		}),
		...detailRowsOf({
			id: "session-error-reply",
			role: "assistant",
			time: { created: 2, completed: 3 },
			parts: [{ id: "reply-text", type: "text", text: "Existing answer" }],
		}),
	]);
	await page.goto(`${baseUrl}/s/${seed}`);
	await expect(page.locator("#input")).toHaveValue(draft);
	await expect(
		page.getByText("Existing answer", { exact: true }),
	).toBeVisible();
	return rpc;
}

async function openMenu(page: Page, id = target) {
	const row = page.locator(`#session-list [data-session-id="${id}"]`);
	await row.hover();
	await row.locator(".session-more-btn").click();
	return row;
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

async function preserved(page: Page, testInfo: TestInfo) {
	await expect(page).toHaveURL(new RegExp(`/s/${seed}$`));
	await expect(page.locator("#input")).toHaveValue(draft);
	await expect(
		page.getByText("Existing answer", { exact: true }),
	).toBeVisible();
	await capture(page, testInfo, "session-error-screen");
}

for (const scenario of [
	{
		tag: "SetSessionSettled",
		command: "settle",
		title: "Couldn't settle session",
		stubs: { SetSessionSettled: refuse },
	},
	{
		tag: "SetSessionPinned",
		command: "pin",
		title: "Couldn't pin session",
		stubs: { SetSessionPinned: refuse },
	},
	{
		tag: "SetSessionAutoSettle",
		command: "auto-settle",
		title: "Couldn't change auto-settle",
		stubs: { SetSessionAutoSettle: refuse },
	},
	{
		tag: "RenameSession",
		command: "rename",
		title: "Couldn't rename session",
		stubs: { RenameSession: refuse },
	},
	{
		tag: "SnoozeSession",
		command: "snooze",
		title: "Couldn't snooze session",
		stubs: { SnoozeSession: refuse },
	},
	{
		tag: "UnsnoozeSession",
		command: "unsnooze",
		title: "Couldn't unsnooze session",
		stubs: { UnsnoozeSession: refuse },
	},
	{
		tag: "MarkSessionRead",
		command: "mark-read",
		title: "Couldn't mark read",
		stubs: { MarkSessionRead: refuse },
	},
	{
		tag: "MarkSessionUnread",
		command: "mark-unread",
		title: "Couldn't mark unread",
		stubs: { MarkSessionUnread: refuse },
	},
	{
		tag: "DeleteSession",
		command: "delete",
		title: 'Couldn\'t delete "Other session"',
		stubs: { DeleteSession: refuse },
	},
] as const) {
	test(`${scenario.tag} refusal shows the action and server reason without changing the session`, async ({
		page,
		harness,
	}, testInfo) => {
		const snoozed = scenario.command === "unsnooze";
		const unread = scenario.command === "mark-read";
		const rpc = await openSession(page, harness.relayBaseUrl, scenario.stubs, {
			unread,
			attention: unread ? "done-unread" : "idle",
			...(snoozed
				? {
						snoozedAt: Date.now() - 1_000,
						snoozedUntil: Date.now() + 3_600_000,
					}
				: {}),
		});
		if (snoozed) await page.getByTestId("snoozed-shelf-toggle").click();
		const row = await openMenu(page);
		await page.getByTestId(`session-ctx-${scenario.command}`).click();
		if (scenario.command === "snooze")
			await page.getByTestId("snooze-option-1h").click();
		if (scenario.command === "rename") {
			const name = page.getByRole("textbox", { name: "Session name" });
			await name.fill("Rejected name");
			await name.press("Enter");
		}
		if (scenario.command === "delete")
			await page.getByTestId("confirm-modal-action").click();
		await rpc.waitForRequest(({ tag }) => tag === scenario.tag);
		const toast = page.getByTestId("toast").filter({ hasText: scenario.title });
		await expect(toast).toContainText(refused);
		await expect(row).toContainText("Other session");
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(
			unread ? 1 : 0,
		);
		await preserved(page, testInfo);
	});
}

for (const action of ["sidebar", "reply"] as const) {
	test(`fork from ${action} shows AccountUnroutable without leaving the source session`, async ({
		page,
		harness,
	}, testInfo) => {
		const rpc = await openSession(page, harness.relayBaseUrl, {
			ForkSession: () => {
				throw unroutable;
			},
		});
		if (action === "sidebar") {
			await openMenu(page, seed);
			await page.getByTestId("session-ctx-fork").click();
		} else {
			await page.getByText("Existing answer", { exact: true }).hover();
			await page.getByRole("button", { name: "Fork from here" }).click();
		}
		const request = await rpc.waitForRequest(
			({ tag }) => tag === "ForkSession",
		);
		expect(request.payload["sessionId"]).toBe(seed);
		if (action === "reply")
			expect(request.payload["messageId"]).toBe("session-error-reply");
		const toast = page
			.getByTestId("toast")
			.filter({ hasText: "Failed to fork session" });
		await expect(toast).toContainText(unroutable.message);
		await preserved(page, testInfo);
	});
}

test("a dropped fork connection shows only the action fallback and keeps the draft", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(page, harness.relayBaseUrl, {
		ForkSession: () => new Promise<never>(() => {}),
	});
	await openMenu(page, seed);
	await page.getByTestId("session-ctx-fork").click();
	await rpc.waitForRequest(({ tag }) => tag === "ForkSession");
	rpc.closeSockets({ code: 1001, reason: "session action connection dropped" });
	const toast = page.getByTestId("toast");
	await expect(toast).toHaveText("Failed to fork session");
	await preserved(page, testInfo);
});

test("Side Thread AccountUnroutable keeps the question in the composer", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(page, harness.relayBaseUrl, {
		StartSideThread: () => {
			throw unroutable;
		},
	});
	const question = "$btw Keep the parent intact";
	await page.locator("#input").fill(question);
	await page.locator("#send").click();
	await rpc.waitForRequest(({ tag }) => tag === "StartSideThread");
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Failed to start Side Thread" });
	await expect(toast).toContainText(unroutable.message);
	await expect(page.locator("#input")).toHaveValue(question);
	await expect(page).toHaveURL(new RegExp(`/s/${seed}$`));
	await capture(page, testInfo, "side-thread-refusal-screen");
});

test("create AccountUnroutable keeps the new session draft", async ({
	page,
	harness,
}, testInfo) => {
	const models = {
		projectSlug,
		instanceId: "opencode",
		defaultOpenCodeInstanceId: "opencode",
		providers: [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{ id: "test-model", name: "Test model", provider: "anthropic" },
				],
			},
		],
		active: { model: "test-model", provider: "anthropic" },
	};
	const rpc = await openSession(page, harness.relayBaseUrl, {
		CreateSession: () => {
			throw unroutable;
		},
		GetModels: () => models,
		SubscribeDraftModels: () => Stream.make(models),
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: singleInstanceList["instances"],
	});
	rpc.setProjectSetting({
		_tag: "defaultModel",
		model: "test-model",
		provider: "anthropic",
		variant: "",
	});
	await page.locator("#new-session-btn").click();
	await expect(page).toHaveURL(
		new RegExp(`/new\\?(?:.*&)?project=${projectSlug}`),
	);
	await expect(page.locator("#model-display")).toContainText("Test model");
	await page.locator("#input").fill(draft);
	await page.locator("#send").click();
	await rpc.waitForRequest(({ tag }) => tag === "CreateSession");
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Failed to create session" });
	await expect(toast).toContainText(unroutable.message);
	await expect(page.locator("#input")).toHaveValue(draft);
	await expect(page).toHaveURL(
		new RegExp(`/new\\?(?:.*&)?project=${projectSlug}`),
	);
	await capture(page, testInfo, "create-refusal-screen");
});

test("cut-off dismissal refusal keeps the tag visible with its server reason", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(
		page,
		harness.relayBaseUrl,
		{ DismissCutOff: refuse },
		{},
		{
			limitRecovery: {
				instanceId: "claude",
				rateLimitType: "five_hour",
				cutOffMessageId: "session-error-question",
				rearms: 0,
				continued: false,
			},
		},
	);
	await page.getByTestId("cut-off-dismiss").click();
	await rpc.waitForRequest(({ tag }) => tag === "DismissCutOff");
	await expect(page.getByTestId("toast")).toContainText(
		"Couldn't dismiss the cut-off",
	);
	await expect(page.getByTestId("toast")).toContainText(refused);
	await expect(page.getByTestId("cut-off-tag")).toBeVisible();
	await preserved(page, testInfo);
});

test("provider reload refusal shows its server reason and keeps the conversation", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(
		page,
		harness.relayBaseUrl,
		{
			ReloadProviderSession: refuse,
			GetClaudeSettings: () => ({ projectSlug, overrides: {} }),
			ResolveClaudeSettings: () => ({
				projectSlug,
				instanceId: "claude",
				resolved: {
					attribution: {},
					autoCompactEnabled: {},
					autoCompactWindow: {},
					cleanupPeriodDays: {},
					disableAllHooks: {},
					alwaysThinkingEnabled: {},
				},
			}),
		},
		{},
		{ accountId: "claude" },
	);
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				isDefault: true,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
			},
		],
	});
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-claude").click();
	const reload = page.getByTestId("claude-settings-reload-session");
	await reload.click();
	const request = await rpc.waitForRequest(
		({ tag }) => tag === "ReloadProviderSession",
	);
	expect(request.payload["sessionId"]).toBe(seed);
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Failed to reload the session" });
	await expect(toast).toContainText(refused);
	await expect(toast).toHaveAttribute("data-variant", "warn");
	await expect(reload).toBeEnabled();
	await page.getByTestId("settings-close-btn").click();
	await preserved(page, testInfo);
});

test("warm session resolution refusal shows its server reason and keeps the current draft", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(page, harness.relayBaseUrl, {});
	rpc.setStubs({ ResolveSession: refuse });
	const missing = "session-error-missing";
	await page.evaluate((id) => {
		history.pushState({}, "", `/s/${id}`);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, missing);
	const request = await rpc.waitForRequest(
		({ tag, payload }) =>
			tag === "ResolveSession" && payload["sessionId"] === missing,
	);
	expect(request.payload["sessionId"]).toBe(missing);
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Failed to open session" });
	await expect(toast).toContainText(refused);
	await expect(page).toHaveURL(new RegExp(`/s/${missing}$`));
	await expect(page.locator("#input")).toHaveValue("");
	await expect(page.getByText("Existing answer", { exact: true })).toBeHidden();
	expect(
		rpc
			.getRequests()
			.filter(
				({ tag, payload }) =>
					payload["sessionId"] === missing &&
					[
						"ViewSession",
						"SubscribeSessionDetail",
						"SubscribeSessionTodos",
						"SubscribeInputDraft",
						"SubscribeSessionFamily",
					].includes(tag),
			),
	).toEqual([]);
	await capture(page, testInfo, "resolve-refusal-screen");
	await page.goBack();
	await preserved(page, testInfo);
});

test("deep search refusal shows the server reason inline and preserves the current session", async ({
	page,
	harness,
}, testInfo) => {
	const rpc = await openSession(page, harness.relayBaseUrl, {});
	rpc.setStubs({ ListDaemonSessions: refuse });
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByTestId("deep-search");
	await expect(palette).toBeVisible();
	await rpc.waitForRequest(
		({ tag, payload }) =>
			tag === "ListDaemonSessions" && payload["limit"] === 8,
	);
	await expect(palette.locator('[aria-live="polite"]')).toHaveText(refused);
	await expect(palette.getByTestId("deep-search-result")).toHaveCount(0);
	await capture(page, testInfo, "deep-search-refusal-screen");
	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();
	await preserved(page, testInfo);
});

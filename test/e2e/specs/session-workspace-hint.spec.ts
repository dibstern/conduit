import type { Page, TestInfo } from "@playwright/test";
import { openSessionPanel } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockDaemonWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", screenshot: "off" });

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			"conduit-composer-preferences",
			JSON.stringify({ controls: "words" }),
		);
	});
});

const projectSlug = "e2e-replay";
const main = "/workspace/conduit";
const hintPath = "/workspace/conduit-hint";

async function openHint(page: Page, appBaseUrl: string) {
	const projects = [
		{ slug: projectSlug, title: "Workspace project", folders: [main] as const },
	];
	const session = {
		accountId: null,
		id: "hint-session",
		title: "Workspace hint",
		status: "idle" as const,
		projectSlug,
		provider: "claude",
		git: { branch: "main" },
		workspaceHint: hintPath,
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			MoveSessionWorkspace: ({ path }) => ({
				projectSlug,
				directory: String(path),
			}),
			DismissWorkspaceHint: () => ({ ok: true }),
			ListDaemonSessions: () => ({
				sessions: [session],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetModels: () => ({
				projectSlug: "e2e-replay",
				providers: [],
			}),
			GetProjects: () => ({ projects, current: projectSlug }),
		},
	});
	rpc.setShellRows([session]);
	rpc.setFamilyRows([session]);
	await mockDaemonWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: projectSlug },
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	await page.goto(`${appBaseUrl}/s/${session.id}`);
	return { rpc, session };
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, animations: "disabled" });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

test("desktop hint acceptance uses the existing workspace move", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { rpc, session } = await openHint(page, harness.appBaseUrl);
	const checkout = page.locator(
		'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
	);
	await expect(
		checkout.getByTestId("workspace-notice-indicator"),
	).toHaveAttribute("aria-label", "working in conduit-hint?");
	await expect(page.getByTestId("picker-checkout-notice-dismiss")).toHaveCount(
		0,
	);
	await capture(page, testInfo, "workspace-hint-desktop");
	await checkout.click();
	await expect(page.getByTestId("picker-row-checkout")).toBeFocused();
	const menu = page.getByTestId("model-picker");
	await expect(
		menu.getByTestId("picker-checkout-notice-dismiss"),
	).toBeVisible();
	await menu.getByTestId("picker-checkout-notice-move").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "MoveSessionWorkspace")
				.map(({ payload }) => payload),
		)
		.toEqual([
			{ _tag: "MoveSessionWorkspace", sessionId: session.id, path: hintPath },
		]);
	// The shell row removes the hint and updates the recorded workspace.
	rpc.upsertShellRow({
		...session,
		workspaceHint: undefined,
		workspace: {
			cause: "user",
			origin: "existing",
			worktrees: { [main]: hintPath },
		},
		git: { branch: "hint", worktree: "conduit-hint" },
	});
	await expect(
		page.locator('[data-testid="workspace-notice-indicator"]:visible'),
	).toHaveCount(0);
	await expect(checkout).toHaveAttribute("title", "conduit-hint / hint");
});

test("desktop dismissal targets the current hint and follows shell row updates", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { rpc, session } = await openHint(page, harness.appBaseUrl);
	const changedPath = "/workspace/conduit-other";
	const checkout = page.locator(
		'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
	);
	const hint = checkout.getByTestId("workspace-notice-indicator");
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-hint?");
	rpc.upsertShellRow({ ...session, workspaceHint: changedPath });
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-other?");
	await checkout.click();
	await page
		.getByTestId("model-picker")
		.getByTestId("picker-checkout-notice-dismiss")
		.click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "DismissWorkspaceHint")
				.map(({ payload }) => payload),
		)
		.toEqual([
			{
				_tag: "DismissWorkspaceHint",
				sessionId: session.id,
				path: changedPath,
			},
		]);
	rpc.upsertShellRow({ ...session, workspaceHint: undefined });
	await expect(
		page.locator('[data-testid="workspace-notice-indicator"]:visible'),
	).toHaveCount(0);
	await expect(page.getByTestId("picker-checkout-notice-move")).toHaveCount(0);
	await expect(page.getByTestId("picker-checkout-notice-dismiss")).toHaveCount(
		0,
	);
	await capture(page, testInfo, "workspace-hint-dismissed");
});

test("phone hint is an accessible chip icon with both actions in the Session panel", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { rpc, session } = await openHint(page, harness.appBaseUrl);
	const checkout = page.locator(
		'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
	);
	const hint = checkout.getByTestId("workspace-notice-indicator");
	await expect(hint).toBeVisible();
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-hint?");
	await expect(hint).toHaveText("");
	await expect(hint.locator("svg")).toBeVisible();
	await capture(page, testInfo, "workspace-hint-phone");
	await expect(page.getByTestId("picker-checkout-notice-move")).toHaveCount(0);
	await expect(page.getByTestId("picker-checkout-notice-dismiss")).toHaveCount(
		0,
	);
	await checkout.click();
	await expect(page.getByTestId("picker-row-checkout")).toBeFocused();
	const panel = page.getByTestId("model-picker");
	await expect(panel.getByTestId("picker-checkout-warning")).toHaveAttribute(
		"aria-label",
		"working in conduit-hint?",
	);
	await expect(
		panel.getByTestId("picker-checkout-notice-dismiss"),
	).toBeVisible();
	await capture(page, testInfo, "workspace-hint-phone-menu");
	await panel.getByTestId("picker-checkout-notice-move").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "MoveSessionWorkspace")
				.map(({ payload }) => payload),
		)
		.toEqual([
			{ _tag: "MoveSessionWorkspace", sessionId: session.id, path: hintPath },
		]);
	await openSessionPanel(page);
	await panel.getByTestId("picker-checkout-notice-dismiss").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "DismissWorkspaceHint")
				.map(({ payload }) => payload),
		)
		.toEqual([
			{ _tag: "DismissWorkspaceHint", sessionId: session.id, path: hintPath },
		]);
	rpc.upsertShellRow({ ...session, workspaceHint: undefined });
	await expect(hint).toHaveCount(0);
	await expect(panel.getByTestId("picker-checkout-warning")).toHaveCount(0);
	await expect(panel.getByTestId("picker-checkout-notice")).toHaveCount(0);
	await testInfo.attach("workspace-hint-rpc", {
		body: JSON.stringify(
			rpc
				.getRequests()
				.filter(({ tag }) =>
					["MoveSessionWorkspace", "DismissWorkspaceHint"].includes(tag),
				),
			null,
			2,
		),
		contentType: "application/json",
	});
});

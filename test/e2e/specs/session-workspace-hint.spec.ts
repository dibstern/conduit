import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

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

async function openHint(page: Page, relayBaseUrl: string) {
	const projects = [
		{ slug: projectSlug, title: "Workspace project", folders: [main] },
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
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "e2e-replay",
				providers: [],
			}),
		},
		handlers: {
			GetProjects: () => ({ projects, current: projectSlug }),
		},
	});
	rpc.setShellRows([session]);
	rpc.setFamilyRows([session]);
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: projectSlug },
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	await page.goto(`${relayBaseUrl}/s/${session.id}`);
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
	const { rpc, session } = await openHint(page, harness.relayBaseUrl);
	const checkout = page.getByTestId("composer-checkout");
	await expect(checkout.getByTestId("workspace-hint")).toHaveAttribute(
		"aria-label",
		"working in conduit-hint?",
	);
	await expect(page.getByTestId("workspace-hint-dismiss")).toHaveCount(0);
	await capture(page, testInfo, "workspace-hint-desktop");
	await checkout.click();
	const menu = page.getByTestId("composer-checkout-menu");
	await expect(menu.getByTestId("workspace-hint-dismiss")).toBeVisible();
	await menu.getByTestId("workspace-hint-move").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "MoveSessionWorkspace")
				.map(({ payload }) => payload),
		)
		.toMatchObject([{ projectSlug, sessionId: session.id, path: hintPath }]);
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
	await expect(page.getByTestId("workspace-hint")).toHaveCount(0);
	await expect(checkout).toHaveAttribute("title", "conduit-hint / hint");
});

test("desktop dismissal targets the current hint and follows shell row updates", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { rpc, session } = await openHint(page, harness.relayBaseUrl);
	const changedPath = "/workspace/conduit-other";
	const checkout = page.getByTestId("composer-checkout");
	const hint = checkout.getByTestId("workspace-hint");
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-hint?");
	rpc.upsertShellRow({ ...session, workspaceHint: changedPath });
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-other?");
	await checkout.click();
	await page
		.getByTestId("composer-checkout-menu")
		.getByTestId("workspace-hint-dismiss")
		.click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "DismissWorkspaceHint")
				.map(({ payload }) => payload),
		)
		.toMatchObject([{ projectSlug, sessionId: session.id, path: changedPath }]);
	rpc.upsertShellRow({ ...session, workspaceHint: undefined });
	await expect(page.getByTestId("workspace-hint")).toHaveCount(0);
	await expect(page.getByTestId("workspace-hint-move")).toHaveCount(0);
	await expect(page.getByTestId("workspace-hint-dismiss")).toHaveCount(0);
	await capture(page, testInfo, "workspace-hint-dismissed");
});

test("phone hint is an accessible icon with both actions in the checkout menu", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { rpc, session } = await openHint(page, harness.relayBaseUrl);
	const checkout = page.getByTestId("composer-checkout");
	const hint = checkout.getByTestId("workspace-hint");
	await expect(hint).toBeVisible();
	await expect(hint).toHaveAttribute("aria-label", "working in conduit-hint?");
	await expect(hint).toHaveText("");
	await expect(hint.locator("svg")).toBeVisible();
	await expect(page.getByTestId("workspace-hint-move")).toHaveCount(0);
	await expect(page.getByTestId("workspace-hint-dismiss")).toHaveCount(0);
	await capture(page, testInfo, "workspace-hint-phone");
	await checkout.click();
	const menu = page.getByTestId("composer-checkout-menu");
	await expect(menu.getByTestId("workspace-hint-dismiss")).toBeVisible();
	await capture(page, testInfo, "workspace-hint-phone-menu");
	await menu.getByTestId("workspace-hint-move").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "MoveSessionWorkspace")
				.map(({ payload }) => payload),
		)
		.toMatchObject([{ projectSlug, sessionId: session.id, path: hintPath }]);
	await checkout.click();
	await menu.getByTestId("workspace-hint-dismiss").click();
	await expect
		.poll(() =>
			rpc
				.getRequests()
				.filter(({ tag }) => tag === "DismissWorkspaceHint")
				.map(({ payload }) => payload),
		)
		.toMatchObject([{ projectSlug, sessionId: session.id, path: hintPath }]);
	rpc.upsertShellRow({ ...session, workspaceHint: undefined });
	await expect(hint).toHaveCount(0);
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

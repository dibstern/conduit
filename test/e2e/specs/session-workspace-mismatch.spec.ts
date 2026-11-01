import { openSessionPanel } from "../helpers/model-picker.js";
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

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	for (const target of ["/workspace/requested-worktree", "/workspace/main"]) {
		test(`workspace mismatch and Retry move to ${target} at ${viewport.width}px`, async ({
			page,
			harness,
		}, testInfo) => {
			await page.setViewportSize(viewport);
			const projectSlug = "e2e-replay";
			const main = "/workspace/main";
			const actualPath = "/workspace/main/.claude/worktrees/contract";
			const projects = [
				{
					slug: projectSlug,
					title: "Workspace project",
					folders: [main] as const,
				},
			];
			const session = {
				accountId: null,
				id: "mismatched-session",
				title: "Workspace mismatch",
				status: "idle" as const,
				projectSlug,
				provider: "claude",
				git: {
					branch: target === main ? "main" : "requested",
					...(target === main ? {} : { worktree: "requested-worktree" }),
				},
				workspace:
					target === main
						? null
						: {
								cause: "user" as const,
								origin: "existing" as const,
								worktrees: { [main]: target },
							},
				workspaceMismatch: { actualPath },
			};
			const rpc = await mockWsRpc(page, {
				stubs: {
					MoveSessionWorkspace: () => ({ projectSlug, directory: target }),
					ListDaemonSessions: () => ({
						sessions: [session],
						availability: [],
						hasMore: false,
						nextCursor: null,
					}),
					GetModels: (input) => ({
						projectSlug:
							"projectSlug" in input ? input.projectSlug : projectSlug,
						providers: [],
					}),
					GetProjects: () => ({
						projects,
						current: projectSlug,
					}),
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
			await page.goto(`${harness.relayBaseUrl}/s/${session.id}`);
			const phone = viewport.width < 768;
			if (phone) {
				await expect(
					page.getByTestId("workspace-notice-indicator"),
				).toBeVisible();
			}
			const checkout = page.getByTestId("composer-checkout");
			await checkout.click();
			await expect(page.getByTestId("picker-row-checkout")).toBeFocused();
			const mismatch = page.locator(
				'[data-testid="picker-checkout-notice"][data-kind="mismatch"]',
			);
			await expect(mismatch).toContainText(actualPath);
			await expect(page.getByTestId("picker-row-checkout")).toContainText(
				target === main ? "main" : "requested",
			);
			await page.getByTestId("picker-row-checkout").click();
			await expect(page.getByTestId("workspace-mismatch")).toContainText(
				`The recorded folder is ${target}`,
			);
			await page.getByTestId("picker-back").click();
			const retry = mismatch.getByTestId("picker-checkout-notice-move");
			await page.screenshot({
				path: testInfo.outputPath("workspace-mismatch.png"),
			});
			await retry.click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "MoveSessionWorkspace")
						.map(({ payload }) => payload),
				)
				.toEqual([
					{ _tag: "MoveSessionWorkspace", sessionId: session.id, path: target },
				]);
			await openSessionPanel(page);
			await expect(mismatch).toBeVisible();
			// The shell feed clears the mismatch without a session-family update.
			rpc.upsertShellRow({ ...session, workspaceMismatch: undefined });
			await expect(mismatch).toHaveCount(0);
			await expect(retry).toHaveCount(0);
			await testInfo.attach("retry-move-rpc", {
				body: JSON.stringify(
					rpc.getRequests().filter(({ tag }) => tag === "MoveSessionWorkspace"),
					null,
					2,
				),
				contentType: "application/json",
			});
		});
	}
}

import type { Page } from "@playwright/test";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { closeSettings } from "../helpers/settings.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const projects: ProjectInfo[] = [
	{
		slug: "e2e-replay",
		title: "Main checkout",
		folders: ["/workspace/myapp"],
		repositoryIdentities: {
			"/workspace/myapp": {
				key: "github.com/acme/myapp",
				name: "Shared repository",
				root: "/workspace/myapp",
			},
		},
	},
	{
		slug: "review-checkout",
		title: "Review checkout",
		folders: ["/workspace/myapp-review"],
		repositoryIdentities: {
			"/workspace/myapp-review": {
				key: "github.com/acme/myapp",
				name: "Shared repository",
				root: "/workspace/myapp-review",
			},
		},
	},
];

async function openList(page: Page, baseUrl: string, query = "") {
	const sessions = projects.map((project, index) => ({
		accountId: null,
		id: `checkout-${project.slug}`,
		title: `Review ${project.title}`,
		status: "idle" as const,
		projectSlug: project.slug,
		updatedAt: 2_000_000_000_000 - index,
		messageCount: 0,
	}));
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			FindFolders: () => ({ home: "/workspace", entries: [] }),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [{ type: "project_list", projects, current: "e2e-replay" }],
		responses: new Map(),
	});
	rpc.setShellRows(sessions);
	await page.goto(`${baseUrl}/${query}`);
	await expect(page.locator("#session-list a[data-session-id]")).toHaveCount(2);
	await expect(page.locator("#connect-overlay")).toBeHidden();
	return rpc;
}

test.afterEach(async ({ page }, info) => {
	const screenshot = info.outputPath("separate-projects.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("separate-projects", {
		path: screenshot,
		contentType: "image/png",
	});
});

for (const viewport of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
	test.describe(viewport.name, () => {
		test.use({ viewport: viewport.viewport, hasTouch: viewport.hasTouch });

		test("shared repository identity keeps separate project headings and scope choices", async ({
			page,
			harness,
		}) => {
			await openList(page, harness.relayBaseUrl, "?group=project");
			const list = page.locator("#session-list");
			for (const project of projects) {
				const heading = list
					.locator(".session-group-label")
					.filter({ hasText: project.title });
				await expect(heading).toHaveCount(1);
				await expect(
					list.locator(
						`#project-tree-rows-${project.slug} a[data-session-id="checkout-${project.slug}"]`,
					),
				).toHaveCount(1);
			}
			await page.getByTestId("session-scope-chip").click();
			await expect(page.getByRole("menuitemradio")).toHaveCount(3);
			await expect(
				page.getByRole("menuitemradio", {
					name: "Shared repository",
					exact: true,
				}),
			).toHaveCount(0);
			for (const project of projects) {
				await expect(
					page
						.getByRole("menuitemradio")
						.filter({ hasText: `project:${project.slug}` }),
				).toHaveCount(1);
			}
		});

		test("old repository scope links replace the URL with the unscoped list", async ({
			page,
			harness,
		}) => {
			const oldScope = ["", "group", "anything"].join("/");
			const rpc = await openList(
				page,
				harness.relayBaseUrl,
				`?${new URLSearchParams({ p: oldScope, group: "project" })}`,
			);
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
			expect(new URL(page.url()).searchParams.has("p")).toBe(false);
			expect(new URL(page.url()).searchParams.get("group")).toBe("project");
			expect(decodeURIComponent(page.url())).not.toContain(oldScope);
			expect(
				rpc
					.getRequests()
					.filter(({ tag }) => tag === "AttachProject")
					.some(({ payload }) => payload["projectSlug"] === oldScope),
			).toBe(false);
			await page.getByTestId("session-scope-chip").click();
			await page
				.getByRole("menuitemradio")
				.filter({ hasText: "project:review-checkout" })
				.click();
			await expect(
				page.locator("#session-list a[data-session-id]"),
			).toHaveCount(1);
			await page.goBack();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
			expect(new URL(page.url()).searchParams.has("p")).toBe(false);
			await expect(
				page.locator("#session-list a[data-session-id]"),
			).toHaveCount(2);
		});

		test("settings and project editing have no repository grouping control", async ({
			page,
			harness,
		}, info) => {
			await openList(page, harness.relayBaseUrl);
			// Each layout reaches Settings through a different menu.
			const listOverflow = page.getByTestId("list-bar-overflow");
			const sessionOverflow = page
				.getByTestId("session-bar-overflow")
				.or(page.getByTestId("session-bar-island-overflow"));
			await expect(listOverflow.or(sessionOverflow).first()).toBeVisible();
			if (await listOverflow.isVisible()) {
				await listOverflow.click();
				await page.getByTestId("list-overflow-settings").click();
			} else {
				await sessionOverflow.click();
				await page.getByTestId("overflow-settings").click();
			}
			await page.getByTestId("settings-tab-general").click();
			const settings = page.locator("#settings-panel");
			await expect(settings).toBeVisible();
			await expect(
				settings.getByRole("combobox", { name: /grouping/i }),
			).toHaveCount(0);
			await expect(settings.getByText(/repository grouping/i)).toHaveCount(0);
			await page.screenshot({
				path: info.outputPath("settings.png"),
				animations: "disabled",
			});
			await closeSettings(page);
			await page.getByTestId("session-scope-chip").click();
			const row = page
				.getByRole("menuitemradio")
				.filter({ hasText: "project:e2e-replay" });
			await row.hover();
			await row.getByTestId("session-scope-edit").click();
			const dialog = page.getByRole("dialog", {
				name: "Edit project",
				exact: true,
			});
			await expect(dialog).toBeVisible();
			await expect(
				dialog.getByRole("combobox", { name: /grouping/i }),
			).toHaveCount(0);
			await expect(
				dialog.getByText("Shared repository · Branch unavailable", {
					exact: true,
				}),
			).toBeVisible();
		});
	});
}

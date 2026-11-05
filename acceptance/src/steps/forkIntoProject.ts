import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

const sheets =
	'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]';
const forkInto = (page: Page) => page.getByTestId("session-ctx-fork-into");
const phoneList = (page: Page) =>
	page.getByRole("menu", { name: "Fork into", exact: true });

async function openCommands(page: Page, viewport: string, sessionId: string) {
	const row = page.locator(`[data-session-id="${sessionId}"]`).first();
	if (viewport === "desktop") {
		await row.click();
		await expect(page).toHaveURL(new RegExp(`/s/${sessionId}(?:[/?]|$)`));
		await row.click({ button: "right" });
		await expect(page.getByRole("menu").first()).toBeVisible();
		return;
	}
	if (!page.url().includes(`/s/${sessionId}`)) {
		await row.click();
		await expect(page).toHaveURL(new RegExp(`/s/${sessionId}(?:[/?]|$)`));
	}
	await page.getByTestId("session-bar-island-overflow").click();
	await expect(page.locator(sheets)).toBeVisible();
}

export const forkIntoProjectHandlers: StepHandler[] = [
	{
		name: "stub fork into the chosen project",
		match: /^the relay forks sessions into the chosen project$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				ForkSession: (payload) => {
					const projectSlug = payload.targetProjectSlug ?? "myapp";
					return {
						projectSlug,
						sessionId: `${projectSlug}-fork`,
						forkedFrom: "sessionId" in payload ? payload.sessionId : "",
					};
				},
			});
		},
	},
	{
		name: "open a session's commands",
		match: /^I open the commands for Atlas session 1 on a (desktop|phone)$/,
		run: async ({ world, match }) => {
			await openCommands(world.page, match[1] ?? "", "myapp-1");
		},
	},
	{
		name: "assert Fork into's projects",
		match: /^Fork into offers ([a-z, ]+) on a (desktop|phone)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const expected = (match[1] ?? "").split(/, | and /);
			const ids =
				match[2] === "desktop"
					? await page
							.locator('[data-testid^="session-ctx-fork-into-"]')
							.evaluateAll((nodes) =>
								nodes.map((node) =>
									node
										.getAttribute("data-testid")
										?.replace("session-ctx-fork-into-", ""),
								),
							)
					: await (async () => {
							await expect(forkInto(page)).toHaveAttribute(
								"data-hold-menu-trigger",
							);
							await forkInto(page).click();
							await expect(phoneList(page)).toBeVisible();
							return phoneList(page)
								.locator("[data-hold-menu-item]")
								.evaluateAll((nodes) =>
									nodes.map((node) => node.getAttribute("data-hold-menu-item")),
								);
						})();
			expect([...ids].sort()).toEqual([...expected].sort());
			await expect(page.getByTestId("session-ctx-fork")).toHaveCount(1);
			const path = `acceptance/visual/artifacts/fork-into-project-${match[2]}.png`;
			await page.screenshot({ path, animations: "disabled" });
			world.artifacts.push(path);
		},
	},
	{
		name: "fork into a project",
		match: /^I fork into ([a-z]+) on a (desktop|phone)$/,
		run: async ({ world, match }) => {
			const target = match[1] ?? "";
			await (match[2] === "desktop"
				? world.page.getByTestId(`session-ctx-fork-into-${target}`).click()
				: phoneList(world.page)
						.locator(`[data-hold-menu-item="${target}"]`)
						.click());
		},
	},
	{
		name: "assert one fork request into the target",
		match: /^exactly one fork request takes Atlas session 1 into ([a-z]+)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(request) => request.tag === "ForkSession",
			);
			expect(request.payload).toMatchObject({
				sessionId: "myapp-1",
				targetProjectSlug: match[1],
			});
			expect(
				rpc.getRequests().filter((request) => request.tag === "ForkSession"),
			).toHaveLength(1);
		},
	},
	{
		name: "assert the fork is open in the target project",
		match: /^the fork is open, attached to the ([a-z]+) project$/,
		run: async ({ world, match }) => {
			const target = match[1] ?? "";
			const sessionId = `${target}-fork`;
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${sessionId}(?:[/?]|$)`),
			);
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.some(
							(request) =>
								request.tag === "AttachProject" &&
								(request.payload["projectSlug"] === target ||
									request.payload["sessionId"] === sessionId),
						),
				)
				.toBe(true);
			const path = `acceptance/visual/artifacts/fork-into-project-opened-${world.page.viewportSize()?.width ?? 0}.png`;
			await world.page.screenshot({ path, animations: "disabled" });
			world.artifacts.push(path);
		},
	},
	{
		name: "seed one session in the only project",
		match: /^Atlas session 1 is a row in the only project$/,
		run: ({ world }) => {
			setSessionRowStatus(world.page, "myapp-1", "idle", {
				title: "Atlas session 1",
				projectSlug: "myapp",
			});
		},
	},
	{
		name: "run a session on OpenCode",
		match: /^Atlas session 1 runs on OpenCode$/,
		run: ({ world }) => {
			setSessionRowStatus(world.page, "myapp-1", "idle", {
				title: "Atlas session 1",
				projectSlug: "myapp",
				accountId: "opencode",
			});
		},
	},
	{
		name: "assert plain Fork only",
		match: /^the commands offer Fork without Fork into$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("session-ctx-fork")).toHaveCount(1);
			await expect(forkInto(world.page)).toHaveCount(0);
		},
	},
];

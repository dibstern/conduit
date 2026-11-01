import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

// Ages are against the frozen page clock, so uptimes read the same every run.
const SERVERS = [
	{
		port: 5173,
		pid: 4101,
		age: 6 * 60,
		command: "node /work/myapp/node_modules/.bin/vite --port 5173",
		cwd: "/work/myapp",
	},
	{
		port: 3000,
		pid: 4102,
		age: 65 * 60,
		command: "node /work/myapp/web/node_modules/.bin/next dev",
		cwd: "/work/myapp/web",
	},
] as const;

async function setServers(page: Page, count: number): Promise<void> {
	const now = await page.evaluate(() => Date.now());
	const rpc = requireRpcControl(page);
	const id = new URL(page.url()).pathname.split("/")[2];
	expect(id, "Servers need an open session").toBeTruthy();
	// Merge into the existing row: a row replaces the session's other state too.
	const row = rpc.shellRows?.find(
		(candidate) => (candidate as { id?: string }).id === id,
	);
	rpc.setShellRows([
		{
			id,
			title: "Stabilise visual suite",
			status: "idle",
			messageCount: 6,
			...(row as object | undefined),
			updatedAt: now,
			// undefined drops out of the JSON snapshot, clearing earlier servers.
			servers:
				count > 0
					? SERVERS.slice(0, count).map(({ age, ...server }) => ({
							...server,
							startedAt: now - age * 1000,
							source: "detected",
							role: "serving",
						}))
					: undefined,
		},
	]);
}

const railButton = (page: Page) => page.getByTestId("views-rail-servers");

export const serversHandlers: StepHandler[] = [
	{
		name: "seed detected servers",
		match: /^the session has (\d) detected servers$/,
		run: async ({ world, match }) => {
			await setServers(world.page, Number(match[1]));
			await expect(railButton(world.page)).toBeVisible();
		},
	},
	{
		name: "every server exits",
		match: /^the session's servers all exit$/,
		run: async ({ world }) => {
			await setServers(world.page, 0);
		},
	},
	{
		name: "assert no Servers rail button",
		match: /^the views rail has no Servers button$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("views-rail-files")).toBeVisible();
			await expect(railButton(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert the Servers rail count",
		match: /^the Servers rail button counts (\d)$/,
		run: async ({ world, match }) => {
			await expect(railButton(world.page)).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "hover the Servers rail button",
		match: /^I hover the Servers rail button$/,
		run: async ({ world }) => {
			await railButton(world.page).hover();
		},
	},
	{
		name: "assert the rail tooltip",
		match: /^the rail tooltip reads (.+) (⌥\d)$/,
		run: async ({ world, match }) => {
			const tooltip = world.page.getByRole("tooltip");
			await expect(tooltip).toHaveText(`${match[1]}${match[2]}`);
			// Park the pointer so the tooltip cannot linger into later shots.
			await world.page.mouse.move(0, 0);
			await expect(tooltip).toHaveCount(0);
		},
	},
	{
		name: "open a view by its shortcut",
		match: /^I press ⌥(\d)$/,
		run: async ({ world, match }) => {
			await world.page.keyboard.press(`Alt+Digit${match[1]}`);
			await expect(world.page.getByTestId("session-servers")).toBeVisible();
		},
	},
	{
		name: "assert the listed servers",
		match: /^the Servers pane lists (.+)$/,
		run: async ({ world, match }) => {
			const rows = world.page.getByTestId("session-server");
			const expected = (match[1] ?? "").split(", ").map((entry) => {
				const [, name, port, uptime] =
					/^(\S+) on (\d+) for (.+)$/.exec(entry) ?? [];
				return { name, port, uptime };
			});
			await expect(rows).toHaveCount(expected.length);
			for (const [i, { name, port, uptime }] of expected.entries()) {
				const row = rows.nth(i);
				await expect(row.getByTestId("session-server-name")).toHaveText(
					name ?? "",
				);
				await expect(row.getByTestId("session-server-port")).toHaveText(
					`:${port}`,
				);
				await expect(row.getByTestId("session-server-uptime")).toHaveText(
					uptime ?? "",
				);
				await expect(row.getByTestId("session-server-command")).toHaveText(
					SERVERS.find((server) => String(server.port) === port)?.command ?? "",
				);
				await expect(row.getByTestId("session-server-source")).toHaveText(
					"detected",
				);
			}
		},
	},
	{
		name: "assert plain localhost Open links",
		match: /^each server opens its plain localhost link in a new tab$/,
		run: async ({ world }) => {
			const rows = world.page.getByTestId("session-server");
			for (let i = 0; i < (await rows.count()); i++) {
				const row = rows.nth(i);
				const port = (
					await row.getByTestId("session-server-port").innerText()
				).slice(1);
				const open = row.getByRole("link", { name: /^Open / });
				await expect(open).toHaveAttribute("href", `http://localhost:${port}`);
				await expect(open).toHaveAttribute("target", "_blank");
				await expect(open).toHaveAttribute("rel", "noopener noreferrer");
			}
		},
	},
	{
		name: "copy a server link",
		match: /^I copy the link of the server on port (\d+)$/,
		run: async ({ world, match }) => {
			await world.page
				.context()
				.grantPermissions(["clipboard-read", "clipboard-write"]);
			await world.page
				.getByTestId("session-server")
				.filter({ hasText: `:${match[1]}` })
				.getByRole("button", { name: /^Copy link/ })
				.click();
		},
	},
	{
		name: "assert the copied link",
		match:
			/^a Link copied toast shows and the clipboard contains (http:\/\/localhost:\d+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("toast").filter({ hasText: "Link copied" }),
			).toBeVisible();
			await expect
				.poll(() => world.page.evaluate(() => navigator.clipboard.readText()))
				.toBe(match[1]);
		},
	},
	{
		name: "assert the empty Servers pane",
		match: /^the Servers pane says no servers are running$/,
		run: async ({ world }) => {
			const pane = world.page.getByTestId("session-servers");
			await expect(pane.getByTestId("session-server")).toHaveCount(0);
			await expect(pane).toContainText("No servers running");
		},
	},
];

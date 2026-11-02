import { expect, type Page } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
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

async function setServers(
	page: Page,
	servers: readonly (typeof SERVERS)[number][],
	// A background task that hosts the server on `port` (8.7).
	hosted?: { readonly port: number; readonly task: string },
): Promise<void> {
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
			...(hosted && {
				backgroundTasks: [
					{
						id: "task-1",
						type: "local_bash",
						description: hosted.task,
						firstSeenAt: now,
					},
				],
			}),
			updatedAt: now,
			// undefined drops out of the JSON snapshot, clearing earlier servers.
			servers:
				servers.length > 0
					? servers.map(({ age, ...server }) => ({
							...server,
							...(server.port === hosted?.port && { taskId: "task-1" }),
							startedAt: now - age * 1000,
							source: "detected",
							role: "serving",
						}))
					: undefined,
		},
	]);
}

const railButton = (page: Page) => page.getByTestId("views-rail-servers");
const sessionRow = (page: Page) =>
	page.locator(
		`#session-list [data-session-id="${new URL(page.url()).pathname.split("/")[2]}"]`,
	);
const viewCards = (page: Page) =>
	page
		.locator(
			'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]',
		)
		.locator("[data-view-card]");
const serverRow = (page: Page, port: string | undefined) =>
	page.getByTestId("session-server").filter({ hasText: `:${port}` });
const menuItem = (page: Page, verb: string) =>
	page.getByTestId(`session-ctx-${verb.toLowerCase()}`);

export const serversHandlers: StepHandler[] = [
	{
		name: "seed detected servers",
		match: /^the session has (\d) detected servers$/,
		run: async ({ world, match }) => {
			await setServers(world.page, SERVERS.slice(0, Number(match[1])));
			// Phones have no views rail; the row badge is the fence there.
			await expect(
				railButton(world.page)
					.or(sessionRow(world.page).getByTestId("session-server-badge"))
					.first(),
			).toBeAttached();
		},
	},
	{
		name: "seed a server a background task hosts",
		match:
			/^the session's background task (.+) hosts the server on port (\d+)$/,
		run: async ({ world, match }) => {
			await setServers(world.page, SERVERS, {
				port: Number(match[2]),
				task: match[1] ?? "",
			});
			await expect(railButton(world.page)).toBeAttached();
		},
	},
	{
		name: "assert a server names its task",
		match: /^the server on port (\d+) names the task (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				serverRow(world.page, match[1]).getByTestId("session-server-task"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert a server names no task",
		match: /^the server on port (\d+) names no task$/,
		run: async ({ world, match }) => {
			await expect(serverRow(world.page, match[1])).toBeVisible();
			await expect(
				serverRow(world.page, match[1]).getByTestId("session-server-task"),
			).toHaveCount(0);
		},
	},
	{
		name: "every server exits",
		match: /^the session's servers all exit$/,
		run: async ({ world }) => {
			await setServers(world.page, []);
		},
	},
	{
		name: "one server exits",
		match: /^the server on port (\d+) exits$/,
		run: async ({ world, match }) => {
			await setServers(
				world.page,
				SERVERS.filter((server) => String(server.port) !== match[1]),
			);
		},
	},
	{
		name: "stop a server",
		match: /^I stop the server on port (\d+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				StopServer: () => ({ ok: true }),
			});
			await serverRow(world.page, match[1])
				.getByTestId("session-server-stop")
				.click();
		},
	},
	{
		name: "assert the Stop confirm",
		match: /^the confirm asks (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#confirm-modal-text")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "confirm the stop",
		match: /^I confirm the stop$/,
		run: async ({ world }) => {
			await world.page.getByTestId("confirm-modal-action").click();
			await expect(world.page.locator("#confirm-modal")).toBeHidden();
		},
	},
	{
		name: "assert the StopServer request",
		match: /^the daemon is asked to stop pid (\d+) on port (\d+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "StopServer",
			);
			expect(request.payload).toMatchObject({
				server: { pid: Number(match[1]), port: Number(match[2]) },
			});
		},
	},
	{
		name: "assert a server reads Stopping",
		match: /^the server on port (\d+) reads Stopping…$/,
		run: async ({ world, match }) => {
			await expect(
				serverRow(world.page, match[1]).getByTestId("session-server-stop"),
			).toHaveText("Stopping…");
		},
	},
	{
		name: "fail the pending Stop",
		match: /^the daemon will fail the Stop with (.+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				StopServer: () => {
					throw new WsRpcError({ message: match[1] ?? "" });
				},
			});
		},
	},
	{
		name: "assert a failed Stop on the row",
		match: /^the server on port (\d+) shows (.+) and offers Stop again$/,
		run: async ({ world, match }) => {
			const row = serverRow(world.page, match[1]);
			await expect(row.getByTestId("session-server-stop-error")).toHaveText(
				match[2] ?? "",
			);
			await expect(row.getByTestId("session-server-stop")).toHaveText("Stop");
			await expect(row.getByTestId("session-server-stop")).toBeEnabled();
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
			await serverRow(world.page, match[1])
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
		name: "open the session's menu in the list",
		match: /^I open the session's menu in the list$/,
		run: async ({ world }) => {
			const id = new URL(world.page.url()).pathname.split("/")[2];
			await world.page
				.locator(`#session-list [data-session-id="${id}"]`)
				.click({ button: "right" });
			await expect(menuItem(world.page, "Settle")).toBeVisible();
		},
	},
	{
		name: "assert a menu item's label",
		match: /^the menu's (Settle|Archive|Delete) reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(menuItem(world.page, match[1] ?? "")).toContainText(
				match[2] ?? "",
			);
		},
	},
	{
		name: "settle or archive from the menu",
		match: /^I (settle|archive) the session from its menu$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setStubs({
				SetSessionSettled: () => ({ ok: true }),
				SetSessionArchived: () => ({ ok: true }),
			});
			await menuItem(world.page, match[1] ?? "").click();
			await rpc.waitForRequest(
				(request) =>
					request.tag ===
					(match[1] === "settle" ? "SetSessionSettled" : "SetSessionArchived"),
			);
		},
	},
	{
		name: "assert a toast",
		match: /^a toast reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("toast")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert the row glyph and server badge",
		match:
			/^the session's row keeps its idle glyph and shows a server badge (with no count|counting (\d))$/,
		run: async ({ world, match }) => {
			const row = sessionRow(world.page);
			await expect(row.locator(".session-status-glyph")).toHaveAttribute(
				"data-state",
				"idle",
			);
			const badge = row.getByTestId("session-server-badge");
			await expect(badge).toBeVisible();
			await expect(badge).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "tap the row's server badge",
		match: /^I tap the session's server badge$/,
		run: async ({ world }) => {
			await sessionRow(world.page).getByTestId("session-server-badge").click();
			await expect(world.page.getByTestId("session-servers")).toBeVisible();
		},
	},
	{
		name: "assert the phone view cards",
		match: /^the view cards read (.+) at today's size$/,
		run: async ({ world, match }) => {
			const cards = viewCards(world.page);
			const labels = (match[1] ?? "").split(", ");
			await expect(cards).toHaveCount(labels.length);
			for (const [i, label] of labels.entries())
				await expect(cards.nth(i)).toHaveAttribute("aria-label", label);
			// Today's size is a quarter of the row less its three 8px gaps; a fifth card scrolls.
			const sizes = await cards.evaluateAll((nodes) =>
				nodes.map((node) => {
					const row = node.parentElement;
					const style = row ? getComputedStyle(row) : undefined;
					const content =
						(row?.clientWidth ?? 0) -
						Number.parseFloat(style?.paddingLeft ?? "0") -
						Number.parseFloat(style?.paddingRight ?? "0");
					return {
						width: node.getBoundingClientRect().width,
						quarter: (content - 24) / 4,
						top: node.getBoundingClientRect().top,
						scrolls: (row?.scrollWidth ?? 0) > (row?.clientWidth ?? 0),
					};
				}),
			);
			for (const { width, quarter, scrolls } of sizes) {
				expect(Math.abs(width - quarter)).toBeLessThanOrEqual(1);
				expect(scrolls).toBe(labels.length > 4);
			}
			expect(new Set(sizes.map(({ top }) => top)).size).toBe(1);
		},
	},
	{
		name: "assert the Servers card's corner badge",
		match: /^the Servers card's corner badge (reads (\d)|is hidden)$/,
		run: async ({ world, match }) => {
			const card = viewCards(world.page).and(
				world.page.getByTestId("overflow-view-servers"),
			);
			const badge = card.locator("[data-view-card-badge]");
			if (match[2] === undefined) {
				await expect(card).toHaveAttribute("aria-checked", "true");
				await expect(badge).toHaveCount(0);
			} else await expect(badge).toHaveText(new RegExp(`^${match[2]}`));
		},
	},
	{
		name: "choose the Servers view card",
		match: /^I choose the Servers view card$/,
		run: async ({ world }) => {
			await world.page.getByTestId("overflow-view-servers").click();
			await expect(world.page.getByTestId("session-servers")).toBeVisible();
			// The tap leaves the pointer over a server's actions; park it on the empty pane below.
			const viewport = world.page.viewportSize();
			await world.page.mouse.move(8, (viewport?.height ?? 800) - 8);
		},
	},
	{
		name: "assert thumb-sized server actions",
		match: /^each server's Open, Copy link and Stop are thumb-sized$/,
		run: async ({ world }) => {
			const rows = world.page.getByTestId("session-server");
			for (let i = 0; i < (await rows.count()); i++)
				for (const name of [/^Open /, /^Copy link/, /^Stop /]) {
					const box = await rows
						.nth(i)
						.getByRole(name.source === "^Open " ? "link" : "button", { name })
						.boundingBox();
					expect(box?.height).toBeGreaterThanOrEqual(44);
					expect(box?.width).toBeGreaterThanOrEqual(44);
				}
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

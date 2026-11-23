import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { rowActivity } from "../../../test/e2e/helpers/rpc-mock.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { longPressSessionRow } from "./sessionSheets.js";
import { requireRpcControl } from "./shared.js";

type Fixture = {
	rows: SessionInfo[];
	id: string;
	originalUrl: string;
	requestUrl: string;
};
const fixtures = new WeakMap<Page, Fixture>();
const dialog = (page: Page) =>
	page.getByRole("dialog").filter({ has: page.locator("#confirm-modal") });
const row = (page: Page, id: string) =>
	page.locator(`#session-list .session-item[data-session-id="${id}"]`);

function fixture(page: Page): Fixture {
	const value = fixtures.get(page);
	if (!value) throw new Error("No settle confirmation fixture");
	return value;
}

async function list(page: Page): Promise<void> {
	if (
		(page.viewportSize()?.width ?? 1440) < 768 &&
		!(await page.locator("#session-list").isVisible())
	)
		await page.getByTestId("session-bar-back").click();
	await expect(row(page, fixture(page).id)).toBeVisible();
}

async function menu(page: Page, id: string): Promise<void> {
	await list(page);
	if ((page.viewportSize()?.width ?? 1440) < 768)
		await longPressSessionRow(page, id);
	else await row(page, id).click({ button: "right" });
}

async function browserFrame(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			),
	);
}

export const settleConfirmHandlers: StepHandler[] = [
	{
		name: "seed settle confirmation sessions and writes",
		match:
			/^the settle confirmation fixture is (plain|servers|worktree|all|untitled|bulk|bulk plain|settled)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = new URL(page.url()).pathname.split("/")[2];
			if (!id) throw new Error("Settle confirmation needs an open session");
			const kind = match[1];
			const count = kind === "bulk" ? 5 : 2;
			const rows: SessionInfo[] = Array.from({ length: count }, (_, index) => ({
				id: index === 0 ? id : `settle-confirm-${index}`,
				accountId: null,
				projectSlug: "myapp",
				title:
					index === 0
						? kind === "untitled"
							? ""
							: "Confirmation target"
						: ([
								"",
								"Second session",
								"Third session",
								"Fourth session",
								"Fifth session",
							][index] ?? "Session"),
				status: "idle",
				attention: "idle",
				activity: rowActivity(false),
				updatedAt: PINNED_CLOCK_MS - index * 60_000,
				...(kind === "settled" && index === 0
					? { settledAt: PINNED_CLOCK_MS }
					: {}),
				...((kind === "servers" || kind === "all" || kind === "bulk") &&
				index < (kind === "bulk" ? 2 : 1)
					? {
							servers: Array.from(
								{ length: index === 0 ? 2 : 1 },
								(_, server) => ({
									port: 5173 + index * 10 + server,
									pid: 4101 + index * 10 + server,
									startedAt: PINNED_CLOCK_MS - 60_000,
									command: "node dev-server.js",
									cwd: "/myapp",
									source: "detected" as const,
									role: "serving" as const,
								}),
							),
						}
					: {}),
				...((kind === "worktree" || kind === "all" || kind === "bulk") &&
				index === 0
					? {
							workspace: {
								cause: "launch" as const,
								origin: "conduit" as const,
								worktrees: { "/myapp": "/worktrees/checkout-one" },
							},
							git: { branch: "feature/checkout-one", worktree: "checkout-one" },
						}
					: {}),
			}));
			const state = {
				rows,
				id,
				originalUrl: page.url(),
				requestUrl: page.url(),
			};
			fixtures.set(page, state);
			const rpc = requireRpcControl(page);
			rpc.setStubs({
				ListDaemonSessions: () => ({
					sessions: state.rows,
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
				SetSessionSettled: ({ sessionId, settled }) => {
					state.rows = state.rows.map((session) =>
						session.id === sessionId
							? { ...session, settledAt: settled ? PINNED_CLOCK_MS : undefined }
							: session,
					);
					rpc.setShellRows(state.rows);
					return { ok: true };
				},
			});
			rpc.setShellRows(rows);
			await expect(page.getByTestId("session-bar-settle")).toBeVisible();
			await browserFrame(page);
		},
	},
	{
		name: "request settle without accepting",
		match:
			/^I request settle confirmation using (header|row menu|other row menu|row key|transcript key|global key|global alias|full swipe|swipe tray|bulk bar)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const state = fixture(page);
			const entry = match[1];
			if (entry === "header") {
				state.requestUrl = page.url();
				await page.getByTestId("session-bar-settle").click();
			} else if (entry === "row menu" || entry === "other row menu") {
				await menu(
					page,
					entry === "other row menu" ? "settle-confirm-1" : state.id,
				);
				state.requestUrl = page.url();
				await page.getByTestId("session-ctx-settle").click();
			} else if (entry === "row key") {
				await list(page);
				await row(page, state.id).focus();
				state.requestUrl = page.url();
				await page.keyboard.press("s");
			} else if (entry === "transcript key") {
				await page.locator("#messages").focus();
				state.requestUrl = page.url();
				await page.keyboard.press("s");
			} else if (entry === "global key" || entry === "global alias") {
				state.requestUrl = page.url();
				await page.keyboard.press(
					`ControlOrMeta+Shift+${entry === "global alias" ? "e" : "s"}`,
				);
			} else if (entry === "bulk bar") {
				await menu(page, state.id);
				await page.getByTestId("session-ctx-select").click();
				for (const session of state.rows.slice(1))
					await row(page, session.id).getByRole("checkbox").click();
				state.requestUrl = page.url();
				await page.getByTestId("select-bar-settle").click();
			} else {
				await list(page);
				state.requestUrl = page.url();
				await row(page, state.id).evaluate(
					(element, distance) => {
						const box = element.getBoundingClientRect();
						const x = box.left + box.width / 2;
						const y = box.top + box.height / 2;
						// No named helper here: tsx wraps it in __name, which the page lacks.
						for (const [type, delta] of [
							["pointerdown", 0],
							["pointermove", 12],
							["pointermove", box.width * distance],
							["pointerup", box.width * distance],
						] as const)
							element.dispatchEvent(
								new PointerEvent(type, {
									pointerType: "touch",
									pointerId: 7,
									isPrimary: true,
									bubbles: true,
									cancelable: true,
									clientX: x + delta,
									clientY: y,
								}),
							);
						(element as HTMLElement).click();
					},
					entry === "full swipe" ? 0.7 : 0.35,
				);
				if (entry === "swipe tray")
					await page
						.getByTestId("session-swipe-settle")
						.click({ position: { x: 20, y: 20 } });
			}
		},
	},
	{
		name: "repeat settle shortcut during confirmation",
		match: /^I press the global settle shortcut again$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("ControlOrMeta+Shift+s");
		},
	},
	{
		name: "repeat bulk settle after cancelling",
		match: /^I press bulk Settle again$/,
		run: async ({ world }) => {
			await world.page.getByTestId("select-bar-settle").click();
		},
	},
	{
		name: "assert settle confirmation heading and action",
		match: /^settle confirmation shows (.+) with action (.+)$/,
		run: async ({ world, match }) => {
			await expect(dialog(world.page)).toHaveCount(1);
			await expect(dialog(world.page)).toBeVisible();
			await expect(world.page.getByTestId("confirm-modal-title")).toHaveText(
				match[1] ?? "",
			);
			await expect(world.page.getByTestId("confirm-modal-action")).toHaveText(
				match[2] ?? "",
			);
			await expect(world.page.getByTestId("confirm-modal-cancel")).toHaveText(
				"Cancel",
			);
		},
	},
	{
		name: "assert settle confirmation title list",
		match: /^settle confirmation session titles are (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("confirm-modal-item-title"),
			).toHaveText((match[1] ?? "").split("|"));
		},
	},
	{
		name: "assert applicable settle consequence",
		match:
			/^settle confirmation (has no|has a) (servers|worktree) consequence$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page).locator(`[data-consequence="${match[2]}"]`),
			).toHaveCount(match[1] === "has no" ? 0 : 1);
		},
	},
	{
		name: "assert exact settle consequence copy",
		match: /^settle confirmation consequence (move|servers|worktree) is (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page).locator(`[data-consequence="${match[1]}"]`),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert responsive confirm geometry",
		match: /^settle confirmation is a (sheet|center)$/,
		run: async ({ world, match }) => {
			const modal = dialog(world.page);
			await expect(modal).toHaveAttribute("data-placement", match[1] ?? "");
			await expect(modal).toBeVisible();
			await expect
				.poll(async () => {
					const bounds = await modal.boundingBox();
					const viewport = world.page.viewportSize();
					if (!bounds || !viewport) return Infinity;
					return match[1] === "sheet"
						? Math.abs(bounds.y + bounds.height - viewport.height)
						: Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2);
				})
				.toBeLessThanOrEqual(2);
		},
	},
	{
		name: "assert settle did not write before confirmation",
		match: /^no settle confirmation write has happened$/,
		run: async ({ world }) => {
			await browserFrame(world.page);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SetSessionSettled"),
			).toHaveLength(0);
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
	{
		name: "accept settle confirmation",
		match: /^I accept settle confirmation using (button|Enter)$/,
		run: async ({ world, match }) => {
			await expect(dialog(world.page)).toBeVisible();
			if (match[1] === "button")
				await world.page.getByTestId("confirm-modal-action").click();
			else await world.page.keyboard.press("Enter");
			await expect(dialog(world.page)).toHaveCount(0);
		},
	},
	{
		name: "cancel settle confirmation",
		match: /^I cancel settle confirmation using (button|Escape)$/,
		run: async ({ world, match }) => {
			await expect(dialog(world.page)).toBeVisible();
			if (match[1] === "button")
				await world.page.getByTestId("confirm-modal-cancel").click();
			else await world.page.keyboard.press("Escape");
			await expect(dialog(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert settle cancellation has no side effects",
		match: /^settle confirmation cancellation preserves the session and URL$/,
		run: async ({ world }) => {
			await browserFrame(world.page);
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(
						(request) =>
							request.tag === "SetSessionSettled" ||
							request.tag === "DeleteSession",
					),
			).toHaveLength(0);
			expect(
				fixture(world.page).rows.every((session) => session.settledAt == null),
			).toBe(true);
			await expect(world.page).toHaveURL(fixture(world.page).requestUrl);
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
	{
		name: "assert confirmed settle writes and state",
		match: /^settle confirmation wrote (true|false) for (\d+) sessions?$/,
		run: async ({ world, match }) => {
			const settled = match[1] === "true";
			const count = Number(match[2]);
			await expect
				.poll(
					() =>
						requireRpcControl(world.page)
							.getRequests()
							.filter(
								(request) =>
									request.tag === "SetSessionSettled" &&
									request.payload["settled"] === settled,
							).length,
				)
				.toBe(count);
			expect(
				new Set(
					requireRpcControl(world.page)
						.getRequests()
						.filter(
							(request) =>
								request.tag === "SetSessionSettled" &&
								request.payload["settled"] === settled,
						)
						.map((request) => request.payload["sessionId"]),
				).size,
			).toBe(count);
			await expect
				.poll(
					() =>
						fixture(world.page).rows.filter(
							(session) => (session.settledAt != null) === settled,
						).length,
				)
				.toBe(settled ? count : fixture(world.page).rows.length);
		},
	},
	{
		name: "assert settle Undo toast",
		match: /^the settle confirmation toast offers Undo$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("toast")
					.getByRole("button", { name: "Undo", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "undo confirmed settle without asking",
		match: /^I undo the confirmed settle$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("toast")
				.getByRole("button", { name: "Undo", exact: true })
				.click();
		},
	},
	{
		name: "assert settle confirm is closed",
		match: /^no settle confirmation is open$/,
		run: async ({ world }) => {
			await expect(dialog(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert settle swipe held or restored",
		match: /^the settle confirmation swipe row (stays open|slides back)$/,
		run: async ({ world, match }) => {
			const target = row(world.page, fixture(world.page).id);
			await expect
				.poll(() =>
					target.evaluate(
						(element) =>
							new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
					),
				)
				.toBeGreaterThanOrEqual(0);
			if (match[1] === "stays open")
				await expect
					.poll(() =>
						target.evaluate(
							(element) =>
								new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
						),
					)
					.toBeGreaterThan(40);
			else
				await expect(target).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
		},
	},
	{
		name: "assert cancelled bulk selection remains",
		match: /^the settle confirmation bulk selection remains$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("select-bar")).toBeVisible();
			await expect(
				world.page.locator(
					'#session-list [role="checkbox"][aria-checked="true"]',
				),
			).toHaveCount(fixture(world.page).rows.length);
		},
	},
	{
		name: "assert settling another row preserves open session",
		match: /^settle confirmation keeps the open session URL$/,
		run: async ({ world }) => {
			await expect(world.page).toHaveURL(fixture(world.page).originalUrl);
		},
	},
	{
		name: "request delete through shared confirm",
		match: /^I request deletion from the settle confirmation row menu$/,
		run: async ({ world }) => {
			await menu(world.page, fixture(world.page).id);
			fixture(world.page).requestUrl = world.page.url();
			await world.page.getByTestId("session-ctx-delete").click();
			await expect(dialog(world.page)).toBeVisible();
		},
	},
	{
		name: "save settle confirmation evidence",
		match: /^settle confirmation evidence is saved as ([a-z0-9-]+)$/,
		run: async ({ world, match }) => {
			const directory = resolve("acceptance/visual/artifacts");
			await mkdir(directory, { recursive: true });
			const path = resolve(
				directory,
				`settle-confirm-${match[1]}-${world.page.viewportSize()?.width}.png`,
			);
			await world.page.screenshot({ path });
			world.artifacts.push(path);
		},
	},
];

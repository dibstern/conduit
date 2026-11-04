import { expect, type Page } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

// The panel choice session (turnPanel.ts) holds the live turn whose head shows the stuck Stop.
const SESSION = "sess-surfacing";
const head = (page: Page) =>
	page.locator("#messages .turn-activity").last().getByTestId("turn-live-head");

const DEV = {
	id: "b1",
	type: "local_bash",
	kind: "shell",
	description: "Start the Vite dev server",
	detail: "pnpm dev",
	firstSeenAt: PINNED_CLOCK_MS - 60_000,
};
const VITEST = {
	id: "b2",
	type: "local_bash",
	kind: "shell",
	description: "Run vitest in watch mode",
	firstSeenAt: PINNED_CLOCK_MS - 30_000,
};

/** The snapshot entry a newer snapshot moves the ask to before the page's next confirm lands. */
const newer = new WeakMap<Page, number>();

const ask = (page: Page, snapshotEntry: number, tasks?: readonly object[]) =>
	setSessionRowStatus(page, SESSION, "busy", {
		stopConfirm: { snapshotEntry, ...(tasks ? { tasks } : {}) },
	});

const stub = (page: Page) =>
	requireRpcControl(page).setStubs({
		ConfirmEscalation: ({ snapshotEntry }) => {
			const moved = newer.get(page);
			if (moved === undefined || moved === snapshotEntry) return { ok: true };
			// The server commits the newer snapshot, then refuses the stale confirm (D45).
			ask(page, moved, [DEV]);
			throw new WsRpcError({
				message:
					"The background tasks changed; check the list and confirm again",
			});
		},
		StopTasks: () => ({ ok: true }),
	});

const dialog = (page: Page) => page.locator("#confirm-modal");

export const stuckStopHandlers: StepHandler[] = [
	{
		name: "hold the Stop for a confirm",
		match:
			/^the Stop is stuck at snapshot entry (\d+) with (a dev server and a vitest shell without its command|no snapshot)$/,
		run: async ({ world, match }) => {
			stub(world.page);
			ask(
				world.page,
				Number(match[1]),
				match[2] === "no snapshot" ? undefined : [DEV, VITEST],
			);
			await expect(head(world.page)).toContainText("Stop is stuck");
		},
	},
	{
		name: "move the ask to a newer snapshot before the confirm lands",
		match:
			/^a newer snapshot at entry (\d+) names only the dev server before the confirm lands$/,
		run: ({ world, match }) => {
			newer.set(world.page, Number(match[1]));
		},
	},
	{
		name: "press a stuck Stop action",
		match: /^I press (Stop now|Stop tasks first) on the stuck Stop$/,
		run: async ({ world, match }) => {
			await head(world.page)
				.getByRole("button", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "assert the confirm copy",
		match: /^the confirm reads "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page).locator("#confirm-modal-text"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "answer the confirm",
		match: /^I (accept|cancel) the confirm$/,
		run: async ({ world, match }) => {
			const modal = dialog(world.page);
			await expect(modal).toBeVisible();
			const text = await modal.locator("#confirm-modal-text").textContent();
			await modal
				.getByRole("button", {
					name: match[1] === "accept" ? "Stop now" : "Cancel",
					exact: true,
				})
				.click();
			// The next ask, if any, is a new dialog: wait for this one's text to leave.
			await expect
				.poll(() =>
					world.page.evaluate(
						() =>
							document.querySelector("#confirm-modal-text")?.textContent ?? "",
					),
				)
				.not.toBe(text);
		},
	},
	{
		name: "assert the confirms sent",
		match: /^the stuck Stop was confirmed at snapshot entries (none|[\d, ]+)$/,
		run: async ({ world, match }) => {
			const entries =
				match[1] === "none" ? [] : (match[1] ?? "").split(", ").map(Number);
			const sent = () =>
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "ConfirmEscalation")
					.map((request) => {
						expect(request.payload["sessionId"]).toBe(SESSION);
						return request.payload["snapshotEntry"];
					});
			await expect.poll(sent).toEqual(entries);
		},
	},
	{
		name: "assert Stop tasks first",
		match: /^the stuck Stop asked to stop all tasks without confirming$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter((request) => request.tag === "StopTasks")
						.map((request) => request.payload["tasks"]),
				)
				.toEqual(["all"]);
			expect(
				rpc
					.getRequests()
					.some((request) => request.tag === "ConfirmEscalation"),
			).toBe(false);
		},
	},
	{
		name: "the stuck Stop fits a phone",
		match: /^the stuck Stop's whole label and both actions are on screen$/,
		run: async ({ world }) => {
			const width = world.page.viewportSize()?.width ?? 0;
			const label = head(world.page).getByText("Stop is stuck", {
				exact: false,
			});
			const shown = [
				label,
				...["Stop now", "Stop tasks first"].map((name) =>
					head(world.page).getByRole("button", { name, exact: true }),
				),
			];
			for (const element of shown) {
				const box = await element.boundingBox();
				expect(box).not.toBeNull();
				expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
			}
			// Cut off means clipped: the label shows its whole text.
			expect(
				await label.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
		},
	},
	{
		name: "end the stuck Stop's ask",
		match: /^the stuck Stop's ask ends$/,
		run: async ({ world }) => {
			// undefined drops out of the row's JSON, clearing the ask.
			setSessionRowStatus(world.page, SESSION, "busy", {
				stopConfirm: undefined,
			});
			await expect(head(world.page)).not.toContainText("Stop is stuck");
		},
	},
];

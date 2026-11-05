import { expect, type Page } from "@playwright/test";
import {
	DeleteNeedsConfirm,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
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

const ask = (
	page: Page,
	snapshotEntry: number,
	tasks?: readonly object[],
	step?: "end_session",
) =>
	setSessionRowStatus(page, SESSION, step ? "idle" : "busy", {
		stopConfirm: {
			snapshotEntry,
			...(tasks ? { tasks } : {}),
			...(step ? { step } : {}),
		},
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
		// The server cancels the held close and the session settles with its tasks.
		DismissEscalation: () => {
			setSessionRowStatus(page, SESSION, "idle", { stopConfirm: undefined });
			return { ok: true };
		},
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
		// A refresh with no live turn: the gate holds main's end_session step (8.4, 2897).
		name: "hold a close for a confirm",
		match:
			/^closing the session is held at snapshot entry (\d+) with (a dev server and a vitest shell without its command|no snapshot)$/,
		run: async ({ world, match }) => {
			stub(world.page);
			ask(
				world.page,
				Number(match[1]),
				match[2] === "no snapshot" ? undefined : [DEV, VITEST],
				"end_session",
			);
			await expect(
				world.page.getByTestId("stuck-stop-actions").last(),
			).toBeVisible();
		},
	},
	{
		name: "press an action on a held close",
		match: /^I press (Close now|Keep tasks) on the held close$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("stuck-stop-actions")
				.last()
				.getByRole("button", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "a held close with no send offers no Keep tasks",
		match: /^the held close offers no Keep tasks$/,
		run: async ({ world }) => {
			const actions = world.page.getByTestId("stuck-stop-actions").last();
			await expect(
				actions.getByRole("button", { name: "Close now", exact: true }),
			).toBeVisible();
			await expect(
				actions.getByRole("button", { name: "Keep tasks", exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the held send was withdrawn",
		match:
			/^the held send was withdrawn once and the held close's actions are gone$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.filter((request) => request.tag === "DismissEscalation")
						.map((request) => request.payload["sessionId"]),
				)
				.toEqual([SESSION]);
			await expect(world.page.getByTestId("stuck-stop-actions")).toHaveCount(0);
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
		name: "a delete needs a confirm while tasks run",
		match:
			/^the panel choice session's background is (a dev server and a vitest shell without its command|being checked), and deleting it needs a confirm of snapshot entry (\d+)$/,
		run: ({ world, match }) => {
			const entry = Number(match[2]);
			setSessionRowStatus(
				world.page,
				SESSION,
				"busy",
				match[1] === "being checked"
					? { tasksChecking: true }
					: { backgroundTasks: [DEV, VITEST] },
			);
			requireRpcControl(world.page).setStubs({
				// The server refuses with the latest entry until the delete carries it (8.4).
				DeleteSession: ({ confirm }) => {
					if (confirm === entry) return { ok: true };
					throw new DeleteNeedsConfirm({ snapshotEntry: entry });
				},
			});
		},
	},
	{
		name: "delete the panel choice session",
		match: /^I delete the panel choice session$/,
		run: async ({ world }) => {
			await world.page
				.locator(`#session-list [data-session-id="${SESSION}"]`)
				.click({ button: "right" });
			await world.page.getByTestId("session-ctx-delete").click();
			await expect(dialog(world.page)).toBeVisible();
		},
	},
	{
		name: "assert the deletes sent",
		match: /^the panel choice session's deletes carried confirms ([\w, ]+)$/,
		run: async ({ world, match }) => {
			const sent = () =>
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "DeleteSession")
					.map((request) => {
						expect(request.payload["sessionId"]).toBe(SESSION);
						return String(request.payload["confirm"] ?? "none");
					});
			await expect.poll(sent).toEqual((match[1] ?? "").split(", "));
		},
	},
	{
		name: "answer the confirm",
		match: /^I (accept|cancel) the (confirm|delete|close)$/,
		run: async ({ world, match }) => {
			const modal = dialog(world.page);
			await expect(modal).toBeVisible();
			const text = await modal.locator("#confirm-modal-text").textContent();
			await modal
				.getByRole("button", {
					name:
						match[1] === "cancel"
							? "Cancel"
							: match[2] === "delete"
								? "Delete"
								: match[2] === "close"
									? "Close now"
									: "Stop now",
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
		match:
			/^the (stuck Stop's whole label and both actions|held close's whole label and its three actions) are on screen$/,
		run: async ({ world, match }) => {
			const width = world.page.viewportSize()?.width ?? 0;
			const held = match[1]?.startsWith("held") ?? false;
			const actions = world.page.getByTestId("stuck-stop-actions").last();
			const label = actions
				.locator("..")
				.getByText(held ? "Close is held" : "Stop is stuck", { exact: false });
			const shown = [
				label,
				...(held
					? ["Close now", "Stop tasks first", "Keep tasks"]
					: ["Stop now", "Stop tasks first"]
				).map((name) => actions.getByRole("button", { name, exact: true })),
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

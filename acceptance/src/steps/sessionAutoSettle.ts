import { expect, type Page } from "@playwright/test";
import {
	type AutoSettleOutlook,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { longPressSessionRow } from "./sessionSheets.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

const outlooks: Record<string, AutoSettleOutlook> = {
	off: { kind: "off" },
	never: { kind: "never" },
	settled: { kind: "settled" },
	due: { kind: "due" },
	scheduled: { kind: "scheduled", at: PINNED_CLOCK_MS + 2 * 86_400_000 },
	pinned: { kind: "paused", reason: "pinned" },
	snoozed: { kind: "paused", reason: "snoozed" },
	unread: { kind: "paused", reason: "unread" },
	working: { kind: "paused", reason: "working" },
	"awaiting-activity": { kind: "paused", reason: "awaiting-activity" },
};

function outlook(name: string | undefined): AutoSettleOutlook {
	const value = name && outlooks[name];
	if (!value) throw new Error(`Unknown auto-settle fixture: ${name}`);
	return value;
}

type HeldReply = {
	started: () => boolean;
	release: () => Promise<void>;
};
const held = new WeakMap<Page, Map<string, HeldReply>>();

export const sessionAutoSettleHandlers: StepHandler[] = [
	{
		name: "stub auto-settle outlook read",
		match: /^the auto-settle read returns (.+)$/,
		run: ({ world, match }) => {
			const reply = outlook(match[1]);
			requireRpcControl(world.page).setStubs({
				GetSessionAutoSettleOutlook: () => reply,
			});
		},
	},
	{
		name: "hold auto-settle reply",
		match: /^the auto-settle (read|write) is held as (.+)$/,
		run: ({ world, match }) => {
			const operation = match[1] ?? "read";
			const tag =
				operation === "read"
					? "GetSessionAutoSettleOutlook"
					: "SetSessionAutoSettle";
			const reply = match[2] === "failure" ? null : outlook(match[2]);
			const rpc = requireRpcControl(world.page);
			let resolve!: (value: AutoSettleOutlook) => void;
			let reject!: (error: WsRpcError) => void;
			const pending = new Promise<AutoSettleOutlook>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			let delivered = false;
			let sessionId: string | undefined;
			const previous = rpc.onReply;
			rpc.onReply = (request) => {
				previous?.(request);
				if (request.tag === tag && request.payload["sessionId"] === sessionId)
					delivered = true;
			};
			rpc.setStubs({
				[tag]: (input: { sessionId: string }) => {
					sessionId = input.sessionId;
					return pending;
				},
			});
			const replies = held.get(world.page) ?? new Map<string, HeldReply>();
			replies.set(operation, {
				started: () => sessionId !== undefined,
				release: async () => {
					await expect.poll(() => sessionId).toBeTruthy();
					if (reply) resolve(reply);
					else reject(new WsRpcError({ message: "Relay unavailable" }));
					await expect.poll(() => delivered).toBe(true);
					// The wire has sent the reply. Cross a browser frame before asserting
					// that an intentionally stale reply left the rendered row untouched.
					await world.page.evaluate(
						() =>
							new Promise<void>((done) =>
								requestAnimationFrame(() =>
									requestAnimationFrame(() => done()),
								),
							),
					);
				},
			});
			held.set(world.page, replies);
		},
	},
	{
		name: "release held auto-settle reply",
		match: /^the held auto-settle (read|write) is released$/,
		run: async ({ world, match }) => {
			const reply = held.get(world.page)?.get(match[1] ?? "");
			if (!reply) throw new Error("No held auto-settle reply");
			await reply.release();
		},
	},
	{
		name: "assert exact auto-settle status",
		match: /^the auto-settle status line is (.+)$/,
		run: async ({ world, match }) => {
			const read = held.get(world.page)?.get("read");
			if (match[1] === "blank" && read)
				await expect.poll(read.started).toBe(true);
			const status = world.page
				.getByTestId("session-ctx-auto-settle")
				.locator("[data-switch-status]");
			await expect(status).toHaveText(
				match[1] === "blank" ? "" : (match[1] ?? ""),
			);
			if (match[1] !== "blank")
				await expect(status.locator("b")).toHaveText(
					match[1]?.startsWith("Off") ? "Off" : "On",
				);
		},
	},
	{
		name: "assert auto-settle saving state and write payload",
		match: /^auto-settle is saving with disabled (true|false)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(request) => request.tag === "SetSessionAutoSettle",
			);
			const read = rpc
				.getRequests()
				.find((request) => request.tag === "GetSessionAutoSettleOutlook");
			expect(request.payload).toMatchObject({
				sessionId: read?.payload["sessionId"],
				disabled: match[1] === "true",
			});
			const row = world.page.getByTestId("session-ctx-auto-settle");
			await expect(row).toHaveAttribute("aria-busy", "true");
			await expect(row).toHaveAttribute("aria-disabled", "true");
			// A second tap while pending cannot send another write.
			await row.dispatchEvent("click");
			expect(
				rpc
					.getRequests()
					.filter((request) => request.tag === "SetSessionAutoSettle"),
			).toHaveLength(1);
		},
	},
	{
		name: "assert auto-settle saving finished",
		match: /^auto-settle is interactive$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("session-ctx-auto-settle");
			await expect(row).toHaveAttribute("aria-busy", "false");
			await expect(row).not.toHaveAttribute("aria-disabled", "true");
		},
	},
	{
		name: "assert no auto-settle error toast",
		match: /^no auto-settle error toast is shown$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
			await expect(
				world.page.getByText("Couldn't change auto-settle", { exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "replace list sheet session while a read is pending",
		match: /^I open the list sheet for another session with a pinned outlook$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const sessionId = "ses_auto_settle_other";
			setSessionRowStatus(world.page, sessionId, "idle", {
				title: "Another session",
				pinnedAt: PINNED_CLOCK_MS - 60_000,
			});
			rpc.setStubs({ GetSessionAutoSettleOutlook: () => outlook("pinned") });
			await longPressSessionRow(world.page, sessionId);
			await expect(
				world.page.getByTestId("session-sheet-header"),
			).toContainText("Another session");
		},
	},
];

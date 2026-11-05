import { expect, type Page } from "@playwright/test";
import { SessionBusy } from "../../../src/lib/contracts/limit-recovery.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";
import { currentSessionId } from "./usageLimitStrip.js";

/** The input id each send held behind the moving head took, per page. */
const heldIds = new WeakMap<Page, Map<string, string>>();

export const headMoveHandlers: StepHandler[] = [
	{
		name: "the daemon holds sends and refuses head moves while the head moves",
		match: /^the conversation is moving to another point$/,
		run: ({ world }) => {
			const relay = requireRelayControl(world.page);
			const held = new Map<string, string>();
			heldIds.set(world.page, held);
			const refuse = ({ sessionId }: { sessionId: string }) => {
				throw new SessionBusy({
					sessionId,
					command: "head_move",
					reason: "head_move_in_progress",
				});
			};
			requireRpcControl(world.page).setStubs({
				// The inbox admits the send as queued; it waits for the move to land.
				"input.submit": ({ sessionId, inputId, text }) => {
					held.set(text, inputId);
					relay.sendMessage({
						type: "mock_pending_input",
						sessionId,
						inputId,
						text,
					});
					return { ok: true, sessionId, handedOff: false };
				},
				RewindSession: refuse,
				UndoRewind: refuse,
			});
		},
	},
	{
		name: "the head lands and the held send starts",
		match: /^the move lands and the held message (.+) starts$/,
		run: async ({ world, match }) => {
			const text = match[1] ?? "";
			const inputId = heldIds.get(world.page)?.get(text);
			if (!inputId) throw new Error(`Nothing was held as ${text}`);
			const sessionId = currentSessionId(world.page);
			await requireRelayControl(world.page).sendMessages([
				{ type: "mock_pending_input_removed", sessionId, inputId },
				{ type: "user_message", text, inputId },
			]);
		},
	},
	{
		name: "the transcript has no user turn with the text",
		match: /^the transcript has no user message (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.locator("#messages .msg-user")
					.filter({ hasText: match[1] ?? "" }),
			).toHaveCount(0);
		},
	},
	{
		name: "the session carries an undoable rewind",
		match: /^the session has a rewind to undo$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).sendChunk(
				"SubscribeSessionDetail",
				[
					{
						_tag: "upsert",
						item: { _tag: "rewind", messageId: "rewound-message" },
						sequence: 1,
					},
				],
				currentSessionId(world.page),
			);
			await expect(world.page.getByTestId("undo-rewind")).toBeVisible();
		},
	},
	{
		name: "undo the rewind",
		match: /^I undo the rewind$/,
		run: async ({ world }) => {
			await world.page.getByTestId("undo-rewind").click();
		},
	},
	{
		name: "the undo toast says why it was refused",
		match: /^the undo is refused with (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.getByTestId("toast")
				.filter({ hasText: "Could not undo the rewind." });
			await expect(toast).toContainText(match[1] ?? "");
			await expect(world.page.getByTestId("undo-rewind")).toBeEnabled();
		},
	},
];

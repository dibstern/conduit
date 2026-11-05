import { expect } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

/** The project tree fixture names its sessions `<slug>-<n>`. */
const ownerOf = (sessionId: string) => sessionId.split("-")[0] ?? null;

/** The ask Beacon session 1 shows once it is open. */
const askId = "beacon-ask";

export const crossProjectAsksHandlers: StepHandler[] = [
	{
		name: "attach the opened session's own project",
		match: /^opening a session attaches the session's own project$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			// The browser marks the placed session's project itself (82tn.13).
			rpc.setStubs({
				ResolveSession: ({ sessionId }) => ({
					projectSlug: ownerOf(sessionId),
				}),
			});
		},
	},
	{
		name: "a Beacon session starts waiting on you",
		match: /^Beacon session (\d+) starts waiting on (approval|a reply)$/,
		run: ({ world, match }) => {
			const approval = match[2] === "approval";
			setSessionRowStatus(world.page, `beacon-${match[1]}`, "idle", {
				title: `Beacon session ${match[1]}`,
				projectSlug: "beacon",
				attention: approval ? "needs-approval" : "needs-reply",
				...(approval
					? { pendingPermissionCount: 1 }
					: { pendingQuestionCount: 1 }),
			});
		},
	},
	{
		name: "refuse an answer to an ask that already settled",
		match:
			/^an answer to Beacon session \d+ is refused because the ask already settled$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const refuse = (): never => {
				// The server's feed drops the settled ask as the refusal comes back.
				rpc.sendChunk("SubscribeApprovals", [
					{ _tag: "remove", id: askId, sequence: 2 },
				]);
				throw new WsRpcError({
					message:
						"This prompt was already answered or ended with its run, so your answer was not sent.",
					code: "prompt-settled",
				});
			};
			rpc.setStubs({
				RespondPermission: refuse,
				AnswerQuestion: refuse,
				RejectQuestion: refuse,
			});
		},
	},
	{
		name: "show the open Beacon session's ask card",
		match: /^Beacon session (\d+) shows its (approval|a reply) card$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const sessionId = `beacon-${match[1]}`;
			await expect.poll(() => rpc.hasStream("SubscribeApprovals")).toBe(true);
			rpc.sendChunk("SubscribeApprovals", [
				{
					_tag: "upsert",
					sequence: 1,
					item:
						match[2] === "approval"
							? {
									_tag: "permission",
									sessionId,
									requestId: askId,
									toolUseId: "beacon-tool",
									toolName: "Bash",
									toolInput: { command: "pnpm deploy" },
								}
							: {
									_tag: "question",
									sessionId,
									toolId: askId,
									toolUseId: "beacon-tool",
									providerId: "claude",
									questions: [
										{
											question: "Deploy now?",
											header: "Deploy",
											options: [{ label: "Yes", description: "Ship it" }],
											multiSelect: false,
										},
									],
								},
				},
			]);
		},
	},
	{
		name: "answer the open ask card",
		match: /^I answer the (approval|a reply) card$/,
		run: async ({ world, match }) => {
			const page = world.page;
			if (match[1] === "approval") {
				await page.getByRole("button", { name: "Allow", exact: true }).click();
				return;
			}
			const card = page.locator(".question-card");
			await card.getByText("Yes", { exact: true }).click();
			await card.locator(".question-submit-btn").click();
		},
	},
	{
		name: "assert the refused answer is told",
		match: /^a toast says the answer was not sent$/,
		run: async ({ world }) => {
			const toast = world.page.getByTestId("toast");
			await expect(toast).toContainText("Answer not sent");
			await expect(toast).toContainText(
				"already answered or ended with its run",
			);
		},
	},
	{
		name: "assert the Beacon session is open in its own project",
		match: /^Beacon session (\d+) is open, attached to the (\w+) project$/,
		run: async ({ world, match }) => {
			const sessionId = `beacon-${match[1]}`;
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${sessionId}(?:[/?]|$)`),
			);
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.some(
							(request) =>
								// The tab follows its marked project's terminals.
								request.tag === "SubscribePtys" &&
								ownerOf(sessionId) === match[2] &&
								request.payload["projectSlug"] === match[2],
						),
				)
				.toBe(true);
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
];

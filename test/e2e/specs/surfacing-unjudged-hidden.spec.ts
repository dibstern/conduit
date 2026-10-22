import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

for (const live of [false, true]) {
	for (const judged of [false, true]) {
		test(`${live ? "live" : "settled"} turns ${judged ? "with probabilities retain category controls" : "without verdicts hide category controls and keep summaries"}`, async ({
			page,
			relayUrl,
		}, testInfo) => {
			const sessionId = "sess-surfacing-unjudged";
			const start = Date.now() - 60_000;
			const parts: HistoryMessagePart[] = [0, 1].flatMap((index) => [
				{
					id: `text-${index}`,
					type: "text",
					text: `Checking implementation ${index + 1}.`,
					// One verdict is enough; leave ordinals absent to test probabilities alone.
					...(judged && index === 1
						? { surfacingProbabilities: { risk: 1 } }
						: {}),
					time: {
						start: start + index * 1000,
						end: start + index * 1000 + 100,
					},
				},
				{
					id: `thinking-${index}`,
					type: "reasoning",
					text: "Checking the next step",
					time: {
						start: start + index * 1000 + 100,
						end: start + index * 1000 + 200,
					},
				},
			]);
			const messages: HistoryMessage[] = [
				{
					id: "user-unjudged",
					role: "user",
					time: { created: start },
					parts: [
						{ id: "request", type: "text", text: "Check the implementation" },
					],
				},
				{
					id: "assistant-unjudged",
					role: "assistant",
					time: {
						created: start + 1,
						...(live ? {} : { completed: start + 2000 }),
					},
					parts,
				},
			];
			await mockWsRpc(page, {
				stubs: {
					GetMessageSurfacing: () => ({
						...DEFAULT_MESSAGE_SURFACING_SETTINGS,
						enabled: true,
						active: true,
						summariesEnabled: true,
						turnsOpen: "minimised",
						key: { source: "stored", rejected: false },
					}),
					GetCategorySet: () => DEFAULT_CATEGORY_SET,
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{
						type: "mock_transcript_snapshot",
						id: sessionId,
						history: { messages, hasMore: false },
					},
					{
						type: "shell_snapshot",
						roots: true,
						sessions: [
							{
								id: sessionId,
								title: "Surfacing without verdicts",
								status: live ? "busy" : "idle",
								updatedAt: start,
								messageCount: messages.length,
							},
						],
					},
					{ type: "status", sessionId, status: live ? "processing" : "idle" },
				],
				responses: new Map(),
			});
			await page.goto(new URL(`/s/${sessionId}`, relayUrl).href);
			const turn = page.locator(".turn-activity");
			await expect(turn).toHaveCount(1);
			// Summaries start disabled until the settings reply has reached the UI.
			const summary = turn.getByRole("button", {
				name: "✦ Summary",
				exact: true,
			});
			await expect(summary).toBeVisible();
			await expect(turn.locator(".turn-activity-toggle")).toContainText(
				live ? "Working" : "Worked",
			);
			if (judged) {
				await turn
					.getByRole("button", { name: "Expand turn", exact: true })
					.click();
				const levels = turn.getByTestId("surfacing-level");
				for (const name of ["Final", "Key", "Balanced", "All"]) {
					await expect(
						levels.getByRole("radio", { name, exact: true }),
					).toBeVisible();
				}
				await expect(
					turn
						.getByTestId("surfacing-pins")
						.locator("button[data-surface-part]")
						.first(),
				).toBeVisible();
			} else {
				await expect(turn).toHaveAttribute("data-minimised", "false");
				await turn.locator(".turn-activity-toggle").click();
				await expect(
					turn.getByText("Checking implementation 1.", { exact: true }),
				).toBeVisible();
				await expect(
					turn.getByText("Waiting for Jev", { exact: false }),
				).toHaveCount(0);
				await expect(turn.getByTestId("surfacing-level")).toHaveCount(0);
				await expect(turn.getByTestId("surfacing-pins")).toHaveCount(0);
				await expect(
					turn.getByRole("button", { name: "Open message #?", exact: true }),
				).toHaveCount(0);
				await summary.click();
				await expect(page.getByTestId("surfacing-summary")).toBeVisible();
			}
			await testInfo.attach("surfacing-turn", {
				body: await turn.screenshot(),
				contentType: "image/png",
			});
		});
	}
}

// Counts must match the messages each level can display, including a live
// pending verdict. Empty middle levels disappear; Final and All stay reachable.
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

const mixed = [
	{ ask: 1 },
	{ risk: 1 },
	...Array.from({ length: 3 }, () => ({ finding: 1 })),
	...Array.from({ length: 3 }, () => ({ finding: 0.5 })),
	{ routine: 1 },
	{ routine: 1 },
	null,
	undefined,
];

for (const scenario of [
	{
		name: "pending messages count at every visible level",
		probabilities: Array.from({ length: 12 }, () => undefined),
		live: true,
		key: 1,
		balanced: 1,
		all: 1,
	},
	{
		name: "mixed live verdicts count cumulatively",
		probabilities: mixed,
		live: true,
		key: 3,
		balanced: 6,
		all: 9,
	},
	{
		name: "settled verdicts hide an empty Key level",
		probabilities: [
			{ finding: 1 },
			{ finding: 1 },
			...Array.from({ length: 10 }, () => ({ finding: 0.5 })),
		],
		live: false,
		key: 0,
		balanced: 2,
		all: 12,
	},
	{
		name: "settled verdicts hide both empty middle levels",
		probabilities: Array.from({ length: 12 }, () => ({ finding: 0.5 })),
		live: false,
		key: 0,
		balanced: 0,
		all: 12,
	},
	{
		name: "Final and All remain with no surfaced messages",
		probabilities: Array.from({ length: 12 }, () => ({ routine: 1 })),
		live: false,
		key: 0,
		balanced: 0,
		all: 0,
	},
]) {
	test(scenario.name, async ({ page, relayUrl }, testInfo) => {
		const sessionId = "sess-surfacing-counts";
		const start = Date.now() - 60_000;
		const parts: HistoryMessagePart[] = scenario.probabilities.flatMap(
			(probabilities, index) => [
				{
					id: `text-${index + 1}`,
					type: "text",
					text: `Model response ${index + 1}: checking the implementation.`,
					surfacingOrdinal: index + 1,
					...(probabilities === undefined
						? {}
						: { surfacingProbabilities: probabilities }),
					time: {
						start: start + index * 1000,
						end: start + index * 1000 + 100,
					},
				},
				{
					id: `thinking-${index + 1}`,
					type: "reasoning",
					text: "Checking",
					time: {
						start: start + index * 1000 + 100,
						end: start + index * 1000 + 200,
					},
				},
			],
		);
		const messages: HistoryMessage[] = [
			{
				id: "user-counts",
				role: "user",
				time: { created: start },
				parts: [
					{ id: "request", type: "text", text: "Check the implementation" },
				],
			},
			{
				id: "assistant-counts",
				role: "assistant",
				time: {
					created: start + 1,
					...(scenario.live ? {} : { completed: start + 13_000 }),
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
					summariesEnabled: false,
					turnsOpen: "expanded",
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
							title: "Surfacing counts",
							status: scenario.live ? "busy" : "idle",
							updatedAt: start,
							messageCount: 2,
						},
					],
				},
				{
					type: "status",
					sessionId,
					status: scenario.live ? "processing" : "idle",
				},
			],
			responses: new Map(),
		});
		await page.goto(new URL(`/s/${sessionId}`, relayUrl).href);
		const levels = page.getByTestId("surfacing-level");
		await expect(levels).toBeVisible();
		await expect(
			levels.getByRole("radio", { name: "Final", exact: true }),
		).toBeVisible();
		for (const [name, count] of [
			["Key", scenario.key],
			["Balanced", scenario.balanced],
			["All", scenario.all],
		] as const) {
			const pill = levels.getByRole("radio", { name, exact: true });
			if (name !== "All" && count === 0) {
				await expect.soft(pill).toHaveCount(0, { timeout: 2000 });
				continue;
			}
			await expect
				.soft(pill.locator("small"))
				.toHaveText(String(count), { timeout: 2000 });
			await pill.click();
			await expect(
				page.getByRole("slider", { name: "Surfaced messages" }),
			).toHaveAttribute("aria-valuemax", String(Math.max(0, count - 1)));
			if (count === 0)
				await expect(
					page.getByTestId("surfacing-pins").locator("button"),
				).toHaveCount(0);
		}
		const screenshot = testInfo.outputPath("surfacing-pills.png");
		await levels.getByRole("radiogroup").screenshot({ path: screenshot });
		await testInfo.attach("surfacing-pills", {
			path: screenshot,
			contentType: "image/png",
		});
	});
}

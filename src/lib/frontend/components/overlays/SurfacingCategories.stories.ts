import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { Schema } from "effect";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import { surfacingSettingsFixture } from "../../../../../test/e2e/fixtures/surfacing-settings.js";
import {
	countSessionCategories,
	DEFAULT_CATEGORY_SET,
	type SurfacingMark,
} from "../../../contracts/category-set.js";
import {
	CountSessionCategories,
	ReplaceCategorySet,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import { SessionMessages, sessionMessages } from "../../stores/chat.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import SurfacingCategories from "./SurfacingCategories.svelte";

// Raw verdicts belong to the server, including messages outside the loaded page.
const verdicts: readonly {
	probabilities: Readonly<Record<string, number>> | null;
	mark?: SurfacingMark;
}[] = [
	{ probabilities: { ask: 0.9, risk: 0.8, routine: 0.1 } },
	{ probabilities: { ask: 0.8, routine: 0.4 } },
	{ probabilities: { risk: 0.9 } },
	{ probabilities: { risk: 0.9 }, mark: { level: "hidden" } },
	{ probabilities: null, mark: { level: "key", category: "finding" } },
	{ probabilities: { routine: 1 }, mark: { level: "all" } },
	{ probabilities: { blocked: 0.99, risk: 0.6 } },
	{ probabilities: { milestone: 0.9, blocked: 0.95 } },
	{
		probabilities: { ask: 0.99 },
		mark: { level: "balanced", category: "finding" },
	},
	{ probabilities: { risk: 1 }, mark: { level: "all", category: "blocked" } },
];
let fixture = surfacingSettingsFixture();
let countRequests = 0;
let rejectCounts = false;
let holdCounts = false;
let releaseCounts: (() => void)[] = [];
const meta = {
	title: "Overlays/SurfacingCategories",
	component: SurfacingCategories,
	parameters: { layout: "fullscreen" },
	args: { active: true, onPageChange: () => {} },
	beforeEach: ({ name }) => {
		const path = routerState.path;
		const compact = sessionViewState.compact;
		const previousMessages = sessionMessages.get("category-counts");
		sessionMessages.set("category-counts", new SessionMessages());
		routerState.path = name === "Without Session" ? "/" : "/s/category-counts";
		sessionViewState.compact = window.innerWidth < 768;
		fixture = surfacingSettingsFixture();
		fixture.stubs.ReplaceCategorySet(
			ReplaceCategorySet.payloadSchema.make({
				expectedVersion: 1,
				nextSet: {
					categories: DEFAULT_CATEGORY_SET.categories.map((category) => ({
						...category,
						retired: category.id === "blocked" || category.id === "milestone",
					})),
				},
			}),
		);
		countRequests = 0;
		rejectCounts = name === "Counts Unavailable";
		holdCounts = false;
		releaseCounts = [];
		const cleanup = [
			connectedSocket(),
			replyRpc("GetCategorySet", fixture.stubs.GetCategorySet),
			replyRpc("ScoreCategorySet", fixture.stubs.ScoreCategorySet),
			replyRpc("ReplaceCategorySet", (payload) =>
				fixture.stubs.ReplaceCategorySet(
					Schema.decodeUnknownSync(ReplaceCategorySet.payloadSchema)(payload),
				),
			),
			replyRpc("CountSessionCategories", (payload) => {
				countRequests++;
				if (rejectCounts)
					throw new WsRpcError({ message: "Fixture counts unavailable" });
				const request = Schema.decodeUnknownSync(
					CountSessionCategories.payloadSchema,
				)(payload);
				expect(request.sessionId).toBe("category-counts");
				const result = countSessionCategories(verdicts, request.set);
				return holdCounts
					? new Promise((resolve) => {
							releaseCounts.push(() => resolve(result));
						})
					: result;
			}),
		];
		return () => {
			for (const restore of cleanup.reverse()) restore();
			routerState.path = path;
			if (previousMessages)
				sessionMessages.set("category-counts", previousMessages);
			else sessionMessages.delete("category-counts");
			sessionViewState.compact = compact;
		};
	},
} satisfies Meta<typeof SurfacingCategories>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SessionCounts: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		for (const [id, text] of Object.entries({
			ask: "2 here",
			risk: "2 here",
			finding: "2 here",
			scope: "0 here",
			replan: "0 here",
			correction: "0 here",
			decision: "0 here",
			blocked: "3 if restored",
			milestone: "1 if restored",
		})) {
			const row = within(
				await canvas.findByTestId(`surfacing-category-row-${id}`),
			);
			await waitFor(() =>
				expect(row.getByTestId("surfacing-category-count")).toHaveTextContent(
					text,
				),
			);
			const count = row.getByTestId("surfacing-category-count");
			await expect(count).toHaveClass("font-mono", "text-text-dimmer");
		}
	},
};

export const RetireRestore: Story = {
	play: async (context) => {
		await SessionCounts.play?.(context);
		const canvas = within(context.canvasElement);
		const original = JSON.stringify(verdicts);
		await userEvent.click(
			canvas.getByRole("spinbutton", { name: "Ask weight" }),
		);
		await userEvent.click(
			within(canvas.getByTestId("surfacing-category-row-ask")).getByRole(
				"button",
				{ name: "Retire" },
			),
		);
		await waitFor(() =>
			expect(
				within(canvas.getByTestId("surfacing-category-row-ask")).getByTestId(
					"surfacing-category-count",
				),
			).toHaveTextContent("2 if restored"),
		);
		await waitFor(() =>
			expect(
				within(canvas.getByTestId("surfacing-category-row-risk")).getByTestId(
					"surfacing-category-count",
				),
			).toHaveTextContent("3 here"),
		);
		await userEvent.click(
			within(canvas.getByTestId("surfacing-draft-bar")).getByRole("button", {
				name: "Save",
			}),
		);
		await waitFor(() =>
			expect(
				fixture.categories.categories.find(({ id }) => id === "ask")?.retired,
			).toBe(true),
		);
		await waitFor(() =>
			expect(canvas.queryByTestId("surfacing-draft-bar")).toBeNull(),
		);
		await userEvent.click(
			within(canvas.getByTestId("surfacing-category-row-ask")).getByRole(
				"button",
				{ name: "Restore" },
			),
		);
		await userEvent.click(
			within(canvas.getByTestId("surfacing-draft-bar")).getByRole("button", {
				name: "Save",
			}),
		);
		await waitFor(() =>
			expect(
				fixture.categories.categories.find(({ id }) => id === "ask")?.retired,
			).toBe(false),
		);
		await waitFor(() =>
			expect(canvas.queryByTestId("surfacing-draft-bar")).toBeNull(),
		);
		await SessionCounts.play?.(context);
		await expect(JSON.stringify(verdicts)).toBe(original);
	},
};

export const WithoutSession: Story = {
	play: async (context) => {
		const canvas = within(context.canvasElement);
		await expect(
			await canvas.findByTestId("surfacing-category-row-ask"),
		).toBeVisible();
		await expect(
			canvas.queryAllByTestId("surfacing-category-count"),
		).toHaveLength(0);
		await expect(countRequests).toBe(0);
		routerState.path = "/s/category-counts";
		await SessionCounts.play?.(context);
		routerState.path = "/";
		await waitFor(() =>
			expect(canvas.queryAllByTestId("surfacing-category-count")).toHaveLength(
				0,
			),
		);
	},
};

export const CountsUnavailable: Story = {
	play: async (context) => {
		const canvas = within(context.canvasElement);
		await expect(
			await canvas.findByText("Could not load session counts."),
		).toBeVisible();
		await expect(canvas.queryByText("0 here")).toBeNull();
		rejectCounts = false;
		await userEvent.click(canvas.getByRole("button", { name: "Retry counts" }));
		await SessionCounts.play?.(context);
	},
};

export const LiveRefresh: Story = {
	play: async (context) => {
		await SessionCounts.play?.(context);
		const canvas = within(context.canvasElement);
		const slot = sessionMessages.get("category-counts");
		if (!slot) throw new Error("Session fixture missing");
		const initialRequests = countRequests;
		holdCounts = true;
		for (let frame = 0; frame < 10; frame++) {
			slot.messages = [...slot.messages];
			await tick();
		}
		await expect(
			within(canvas.getByTestId("surfacing-category-row-ask")).getByTestId(
				"surfacing-category-count",
			),
		).toHaveTextContent("2 here");
		await expect(countRequests).toBe(initialRequests);
		slot.messages = [
			...slot.messages,
			{ type: "system", uuid: "new-message", text: "A new message" },
		];
		await waitFor(() => expect(releaseCounts).toHaveLength(1));
		slot.messages = [
			...slot.messages,
			{ type: "system", uuid: "latest-message", text: "A later message" },
		];
		await tick();
		holdCounts = false;
		releaseCounts[0]?.();
		await waitFor(() => expect(countRequests).toBe(initialRequests + 2));
		await SessionCounts.play?.(context);
	},
};

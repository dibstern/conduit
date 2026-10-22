import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { Schema } from "effect";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { surfacingTuningFixture } from "../../../../../test/e2e/fixtures/surfacing-tuning.js";
import {
	BUILTIN_CATEGORIES,
	CategorySetContentsSchema,
} from "../../../contracts/category-set.js";
import { CategoryTuningHunkSchema } from "../../../contracts/category-tuning.js";
import {
	ProposeCategoryTuning,
	ReplaceCategorySet,
	ScoreCategorySet,
} from "../../../contracts/ws-rpc.js";
import { applyInstanceListResponse } from "../../stores/instance.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { applyUsageReadings } from "../../stores/usage.svelte.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import SettingsPanel from "./SettingsPanel.svelte";

let fixture = surfacingTuningFixture();
const meta = {
	title: "Overlays/SurfacingTuning",
	component: SettingsPanel,
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "720px" } },
	},
	args: { visible: true, initialTab: "surfacing" },
	beforeEach: ({ name }) => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = window.innerWidth < 768;
		routerState.path = "/";
		applyInstanceListResponse({ instances: [] });
		applyUsageReadings([]);
		fixture = surfacingTuningFixture({
			marks: name.startsWith("Empty")
				? 0
				: name.startsWith("Few Marks")
					? 4
					: 6,
			key: name.startsWith("No Key") ? "none" : "valid",
			unjudged: name.startsWith("No Key Unjudged"),
		});
		if (name.startsWith("All Categories")) {
			const record = fixture.records[0];
			if (!record) throw new Error("Missing feedback fixture record");
			fixture.records.splice(
				0,
				fixture.records.length,
				...BUILTIN_CATEGORIES.map((category, index) => ({
					...record,
					partId: `category-colours-${category.id}`,
					ordinal: index + 1,
					text: category.criteria.what,
					probabilities: { [category.id]: 1 },
					mark: { level: "key" as const, direction: "raise" as const },
				})),
			);
		}
		if (name.startsWith("Proposing")) fixture.setProposalState("pending");
		if (name.startsWith("Failed")) fixture.setProposalState("failed");
		if (name.startsWith("No Changes")) fixture.setProposalState("empty");
		const cleanup = [
			connectedSocket(),
			replyRpc("GetMessageSurfacing", fixture.stubs.GetMessageSurfacing),
			replyRpc("GetCategorySet", fixture.stubs.GetCategorySet),
			replyRpc("GetSurfacingLedger", fixture.stubs.GetSurfacingLedger),
			replyRpc("ScoreCategorySet", (payload) =>
				fixture.stubs.ScoreCategorySet(
					ScoreCategorySet.payloadSchema.make(
						Schema.decodeUnknownSync(
							Schema.Struct({
								set: CategorySetContentsSchema,
								estimateOnly: Schema.optionalKey(Schema.Boolean),
							}),
						)(payload),
					),
				),
			),
			replyRpc("ProposeCategoryTuning", (payload) =>
				fixture.stubs.ProposeCategoryTuning(
					ProposeCategoryTuning.payloadSchema.make(
						Schema.decodeUnknownSync(
							Schema.Struct({
								avoid: Schema.optionalKey(
									Schema.Array(CategoryTuningHunkSchema),
								),
							}),
						)(payload),
					),
				),
			),
			replyRpc("ReplaceCategorySet", (payload) =>
				fixture.stubs.ReplaceCategorySet(
					ReplaceCategorySet.payloadSchema.make(
						Schema.decodeUnknownSync(
							Schema.Struct({
								expectedVersion: Schema.Number,
								nextSet: CategorySetContentsSchema,
							}),
						)(payload),
					),
				),
			),
		];
		return () => {
			fixture.resolveProposal();
			for (const restore of cleanup.reverse()) restore();
			sessionViewState.compact = compact;
		};
	},
} satisfies Meta<typeof SettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
type Play = NonNullable<Story["play"]>;

const feedback: Play = async ({ canvasElement }) => {
	const body = within(canvasElement.ownerDocument.body);
	await expect(await body.findByTestId("surfacing-key-state")).toBeVisible();
	await userEvent.click(body.getByTestId("surfacing-tab-feedback"));
	await expect(
		await body.findByTestId("surfacing-settings-feedback"),
	).toBeVisible();
	if (fixture.records.length)
		await expect(
			await body.findAllByTestId("surfacing-ledger-record"),
		).toHaveLength(fixture.records.length);
	else
		await expect(body.queryAllByTestId("surfacing-ledger-record")).toHaveLength(
			0,
		);
	if (fixture.records.length) {
		for (const record of body.getAllByTestId("surfacing-ledger-record")) {
			await expect(record).not.toHaveTextContent(/\batKey\b/);
		}
		const tiles = body.getByTestId("surfacing-feedback-tiles");
		for (const value of tiles.querySelectorAll("b")) {
			await expect(getComputedStyle(value).color).toBe(
				getComputedStyle(body.getByRole("heading", { name: "Surfacing" }))
					.color,
			);
		}
		const groupLabel = body.getByRole("heading", {
			name: "Jev said → you said",
		});
		for (const label of tiles.querySelectorAll(
			":scope > div > small, :scope > div > span",
		)) {
			await expect(getComputedStyle(label).color).toBe(
				getComputedStyle(groupLabel).color,
			);
		}
	}
	(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
};
const empty: Play = async (context) => {
	await feedback(context);
	const body = within(context.canvasElement.ownerDocument.body);
	await expect(
		await body.findByText(
			/Raise or lower a few messages and Opus can propose fixes/,
		),
	).toBeVisible();
	await expect(
		body.getByRole("button", { name: "Propose changes" }),
	).toBeDisabled();
};
const propose: Play = async (context) => {
	await feedback(context);
	const body = within(context.canvasElement.ownerDocument.body);
	await userEvent.click(body.getByRole("button", { name: "Propose changes" }));
	(
		context.canvasElement.ownerDocument.activeElement as HTMLElement | null
	)?.blur();
};
const review: Play = async (context) => {
	await propose(context);
	const body = within(context.canvasElement.ownerDocument.body);
	await expect(
		await body.findByTestId("surfacing-proposal-review"),
	).toBeVisible();
	await waitFor(() =>
		expect(
			body.getByTestId("surfacing-proposal-hunk-finding-weight"),
		).toHaveTextContent("Agreement"),
	);
	await waitFor(() =>
		expect(body.getByTestId("surfacing-proposal-review")).toHaveTextContent(
			"which costs 9 Jev calls",
		),
	);
	await waitFor(() => {
		const test = body.getByTestId(
			"surfacing-proposal-test-milestone-definition",
		);
		if (fixture.settings.settings.active) expect(test).toBeEnabled();
		else expect(test).toBeDisabled();
	});
	await expect(
		body.getByRole("checkbox", { name: "Include Finding change" }),
	).toBeChecked();
	const checkbox = body.getByRole("checkbox", {
		name: "Include Finding change",
	});
	await expect(checkbox.getBoundingClientRect().width).toBe(16);
	await expect(checkbox.getBoundingClientRect().height).toBe(16);
	await expect(getComputedStyle(checkbox).appearance).toBe("none");
	await expect(getComputedStyle(checkbox).borderRadius).toBe("4px");
	await expect(getComputedStyle(checkbox).backgroundColor).toBe(
		context.canvasElement.ownerDocument.documentElement.classList.contains(
			"light-theme",
		)
			? "rgb(67, 82, 210)"
			: "rgb(142, 155, 255)",
	);
	await userEvent.click(checkbox);
	await expect(checkbox).not.toBeChecked();
	await expect(getComputedStyle(checkbox).backgroundColor).toBe(
		"rgba(0, 0, 0, 0)",
	);
	await expect(getComputedStyle(checkbox).borderTopStyle).toBe("solid");
	checkbox.blur();
	const uncheckedShadow = getComputedStyle(checkbox).boxShadow;
	await expect(getComputedStyle(checkbox).borderTopWidth).toBe("1px");
	await expect(uncheckedShadow).toContain("0.5px inset");
	checkbox.focus();
	await userEvent.tab({ shift: true });
	await userEvent.tab();
	await expect(checkbox).toHaveFocus();
	await expect(checkbox.matches(":focus-visible")).toBe(true);
	await expect(getComputedStyle(checkbox).boxShadow).not.toBe(uncheckedShadow);
	await expect(getComputedStyle(checkbox).boxShadow).toContain(
		"0px 0px 0px 2px",
	);
	await userEvent.click(checkbox);
	await expect(checkbox).toBeChecked();
	checkbox.blur();
	const again = body.getByTestId("surfacing-proposal-again");
	await expect(again.getBoundingClientRect().height).toBe(28);
	await expect(getComputedStyle(again).borderTopWidth).toBe("0px");
	await expect(
		body.getByTestId("surfacing-proposal-hunk-finding-weight"),
	).toHaveTextContent("40");
	await expect(
		body.getByTestId("surfacing-proposal-hunk-finding-weight"),
	).toHaveTextContent("60");
	await expect(fixture.settings.categories.version).toBe(1);
};

export const Empty: Story = { play: empty };
export const EmptyLight: Story = { ...Empty, globals: { theme: "light" } };
export const FewMarks: Story = { play: empty };
export const FewMarksLight: Story = {
	...FewMarks,
	globals: { theme: "light" },
};
export const Ledger: Story = { play: feedback };
export const LedgerLight: Story = { ...Ledger, globals: { theme: "light" } };
export const AllCategories: Story = {
	play: async (context) => {
		await feedback(context);
		const grid = within(context.canvasElement.ownerDocument.body).getByTestId(
			"surfacing-feedback-grid",
		);
		const glyphs = grid.querySelectorAll("tbody td:first-child [aria-hidden]");
		await expect(glyphs).toHaveLength(9);
		await expect(
			new Set([...glyphs].map((glyph) => getComputedStyle(glyph).color)).size,
		).toBe(9);
	},
};
export const AllCategoriesLight: Story = {
	...AllCategories,
	globals: { theme: "light" },
};
export const NoKey: Story = {
	play: async (context) => {
		await review(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await waitFor(() =>
			expect(body.getByTestId("surfacing-proposal-review")).toHaveTextContent(
				"TypeSafe key",
			),
		);
		await expect(body.getByTestId("surfacing-proposal-apply")).toBeEnabled();
	},
};
export const NoKeyLight: Story = { ...NoKey, globals: { theme: "light" } };
export const NoKeyUnjudged: Story = {
	play: async (context) => {
		await feedback(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await expect(
			body.getByTestId("surfacing-feedback-tiles"),
		).toHaveTextContent("Unavailable");
		await expect(
			body.getAllByTestId("surfacing-ledger-record")[0],
		).toHaveTextContent("Not judged");
	},
};
export const NoKeyUnjudgedLight: Story = {
	...NoKeyUnjudged,
	globals: { theme: "light" },
};
export const Proposing: Story = {
	play: async (context) => {
		await propose(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await waitFor(() =>
			expect(body.getByTestId("surfacing-settings-feedback")).toHaveTextContent(
				/Proposing|Reading 6 marks/,
			),
		);
	},
};
export const ProposingLight: Story = {
	...Proposing,
	globals: { theme: "light" },
};
export const Failed: Story = {
	play: async (context) => {
		await propose(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await expect(
			await body.findByRole("button", { name: "Retry" }),
		).toBeVisible();
		await expect(
			body.getByTestId("surfacing-settings-feedback"),
		).toHaveTextContent("Claude is not signed in");
	},
};
export const FailedLight: Story = { ...Failed, globals: { theme: "light" } };
export const NoChanges: Story = {
	play: async (context) => {
		await propose(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await waitFor(() =>
			expect(
				within(body.getByTestId("surfacing-settings-feedback")).getByRole(
					"status",
				),
			).toHaveTextContent("No changes suggested"),
		);
	},
};
export const NoChangesLight: Story = {
	...NoChanges,
	globals: { theme: "light" },
};
export const Review: Story = { play: review };
export const ReviewLight: Story = { ...Review, globals: { theme: "light" } };
export const StaleProposal: Story = {
	play: async (context) => {
		await review(context);
		fixture.settings.changeElsewhere();
		const body = within(context.canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("surfacing-proposal-apply"));
		await expect(
			await body.findByText(/Categories changed elsewhere/),
		).toBeVisible();
		await expect(body.getByTestId("surfacing-proposal-apply")).toBeDisabled();
		await expect(body.getByTestId("surfacing-proposal-again")).toBeEnabled();
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};
export const StaleProposalLight: Story = {
	...StaleProposal,
	globals: { theme: "light" },
};

const categoryPreview: Play = async ({ canvasElement }) => {
	const body = within(canvasElement.ownerDocument.body);
	await expect(await body.findByTestId("surfacing-key-state")).toBeVisible();
	await userEvent.click(body.getByTestId("surfacing-tab-categories"));
	// 40 -> 60, the spec's draft, so the readout shows its arrows.
	for (let step = 0; step < 4; step++)
		await userEvent.click(
			body.getByRole("button", { name: "Raise Finding weight" }),
		);
	await waitFor(() =>
		expect(body.getByTestId("surfacing-category-preview")).toHaveTextContent(
			"agrees with",
		),
	);
	await expect(
		body.getByTestId("surfacing-category-preview-test"),
	).toBeDisabled();
	await expect(
		fixture.scoreRequests.every(({ jevCalls }) => jevCalls === 0),
	).toBe(true);
	showPreview(canvasElement);
};
/** Blur, and bring the readout at the top of Categories back into view. */
function showPreview(canvasElement: HTMLElement): void {
	const document = canvasElement.ownerDocument;
	(document.activeElement as HTMLElement | null)?.blur();
	for (
		let element = document.querySelector<HTMLElement>(
			'[data-testid="surfacing-category-preview"]',
		);
		element;
		element = element.parentElement
	)
		element.scrollTop = 0;
}
export const CategoriesWeightPreview: Story = { play: categoryPreview };
export const CategoriesWeightPreviewLight: Story = {
	...CategoriesWeightPreview,
	globals: { theme: "light" },
};
export const CategoriesDefinitionPreview: Story = {
	play: async (context) => {
		await categoryPreview(context);
		const body = within(context.canvasElement.ownerDocument.body);
		// Row actions show on hover or focus; focus works without a real pointer.
		body.getByRole("spinbutton", { name: "Milestone weight" }).focus();
		await userEvent.click(
			body.getByRole("button", {
				name: "Edit Milestone definition",
			}),
		);
		await userEvent.type(
			body.getByRole("textbox", { name: "Not for" }),
			"build or test runs that only report green",
		);
		await userEvent.click(body.getByTestId("surfacing-category-apply"));
		await waitFor(() =>
			expect(body.getByTestId("surfacing-category-preview")).toHaveTextContent(
				/9.*Jev calls/,
			),
		);
		await waitFor(() =>
			expect(body.getByTestId("surfacing-category-preview-test")).toBeEnabled(),
		);
		await expect(
			fixture.scoreRequests.every(({ jevCalls }) => jevCalls === 0),
		).toBe(true);
		showPreview(context.canvasElement);
	},
};
export const CategoriesDefinitionPreviewLight: Story = {
	...CategoriesDefinitionPreview,
	globals: { theme: "light" },
};

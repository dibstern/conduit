import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { Schema } from "effect";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { surfacingSettingsFixture } from "../../../../../test/e2e/fixtures/surfacing-settings.js";
import { CategorySetContentsSchema } from "../../../contracts/category-set.js";
import { MessageSurfacingPatchSchema } from "../../../contracts/message-surfacing.js";
import {
	ReplaceCategorySet,
	UpdateMessageSurfacing,
} from "../../../contracts/ws-rpc.js";
import { applyInstanceListResponse } from "../../stores/instance.svelte.js";
import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { applyUsageReadings } from "../../stores/usage.svelte.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import SettingsPanel from "./SettingsPanel.svelte";

let fixture = surfacingSettingsFixture();
const meta = {
	title: "Overlays/SurfacingSettings",
	component: SettingsPanel,
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "720px" } },
	},
	args: { visible: true, initialTab: "surfacing" },
	beforeEach: ({ name }) => {
		const compact = sessionViewState.compact;
		const previousStatus = messageSurfacing.status;
		sessionViewState.compact = window.innerWidth < 768;
		routerState.path = "/";
		applyInstanceListResponse({ instances: [] });
		applyUsageReadings([]);
		fixture = surfacingSettingsFixture({
			source:
				name.startsWith("Valid") ||
				name.startsWith("Active") ||
				name.startsWith("Jev Off") ||
				name.startsWith("Rejected")
					? "stored"
					: name.startsWith("Environment")
						? "env"
						: "none",
			rejected: name.startsWith("Rejected"),
		});
		if (name.startsWith("Jev Off") || name.startsWith("No Key Summaries"))
			fixture.stubs.UpdateMessageSurfacing(
				UpdateMessageSurfacing.payloadSchema.make({ summariesEnabled: true }),
			);
		const cleanup = [
			connectedSocket(),
			replyRpc("GetMessageSurfacing", fixture.stubs.GetMessageSurfacing),
			replyRpc("GetCategorySet", fixture.stubs.GetCategorySet),
			replyRpc("GetSurfacingLedger", fixture.stubs.GetSurfacingLedger),
			replyRpc("ScoreCategorySet", fixture.stubs.ScoreCategorySet),
			replyRpc("UpdateMessageSurfacing", (payload) =>
				fixture.stubs.UpdateMessageSurfacing(
					UpdateMessageSurfacing.payloadSchema.make(
						Schema.decodeUnknownSync(MessageSurfacingPatchSchema)(payload),
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
			for (const restore of cleanup.reverse()) restore();
			sessionViewState.compact = compact;
			messageSurfacing.status = previousStatus;
		};
	},
} satisfies Meta<typeof SettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const general: NonNullable<Story["play"]> = async ({ canvasElement }) => {
	const body = within(canvasElement.ownerDocument.body);
	await expect(await body.findByTestId("surfacing-key-state")).toBeVisible();
	await expect(
		body.getByRole("switch", { name: "Jev categorisation & escalation" }),
	).toHaveAttribute("aria-checked", "false");
	await expect(body.getByTestId("surfacing-disclosure")).toBeVisible();
	if (fixture.settings.key.source === "env")
		await expect(body.queryByTestId("surfacing-key-input")).toBeNull();
};

export const General: Story = { play: general };
export const GeneralLight: Story = { ...General, globals: { theme: "light" } };
export const JevOffSummariesOn: Story = {
	play: async (context) => {
		await general(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await expect(
			body.getByRole("switch", { name: "Turn summaries" }),
		).toHaveAttribute("aria-checked", "true");
	},
};
export const JevOffSummariesOnLight: Story = {
	...JevOffSummariesOn,
	globals: { theme: "light" },
};
export const NoKeySummaries: Story = {
	play: async (context) => {
		await general(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await expect(
			body.getByRole("switch", { name: "Jev categorisation & escalation" }),
		).toBeDisabled();
		await expect(
			body.getByRole("switch", { name: "Turn summaries" }),
		).toBeEnabled();
		await expect(
			body.getByRole("switch", { name: "Turn summaries" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(body.getByTestId("surfacing-add-key")).toBeVisible();
	},
};
export const NoKeySummariesLight: Story = {
	...NoKeySummaries,
	globals: { theme: "light" },
};
export const ValidKey: Story = { play: general };
export const ValidKeyLight: Story = {
	...ValidKey,
	globals: { theme: "light" },
};
export const Active: Story = {
	play: async (context) => {
		await general(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await userEvent.click(
			body.getByRole("switch", { name: "Jev categorisation & escalation" }),
		);
		await expect(body.getByText("● Active")).toBeVisible();
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};
export const ActiveLight: Story = { ...Active, globals: { theme: "light" } };
export const RejectedKey: Story = {
	play: async (context) => {
		await general(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await userEvent.click(
			body.getByRole("switch", { name: "Jev categorisation & escalation" }),
		);
		await expect(
			body.getByText("Inactive until a valid key is set"),
		).toBeVisible();
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};
export const RejectedKeyLight: Story = {
	...RejectedKey,
	globals: { theme: "light" },
};
export const EnvironmentKey: Story = { play: general };
export const EnvironmentKeyLight: Story = {
	...EnvironmentKey,
	globals: { theme: "light" },
};

const categories: NonNullable<Story["play"]> = async (context) => {
	await general(context);
	const body = within(context.canvasElement.ownerDocument.body);
	await userEvent.click(body.getByTestId("surfacing-tab-categories"));
	await expect(
		body.getByTestId("surfacing-category-row-finding"),
	).toBeVisible();
	await userEvent.click(
		body.getByRole("button", { name: "Raise Finding weight" }),
	);
	await expect(
		body.getByRole("spinbutton", { name: "Finding weight" }),
	).toHaveValue(45);
	await expect(body.getByTestId("surfacing-draft-bar")).toBeVisible();
	await waitFor(() =>
		expect(body.getByTestId("surfacing-category-preview")).toHaveTextContent(
			"No judged messages yet",
		),
	);
	await expect(fixture.categories.version).toBe(1);
	(
		context.canvasElement.ownerDocument.activeElement as HTMLElement | null
	)?.blur();
};
export const CategoriesDraft: Story = { play: categories };
export const CategoriesDraftLight: Story = {
	...CategoriesDraft,
	globals: { theme: "light" },
};

export const CategoryEditor: Story = {
	play: async (context) => {
		await categories(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("surfacing-category-add"));
		await userEvent.type(body.getByRole("textbox", { name: "Label" }), "Perf");
		await userEvent.type(body.getByRole("textbox", { name: "Glyph" }), "⚡⚡");
		await userEvent.type(
			body.getByRole("textbox", { name: "Surface when" }),
			"reports a measured change in latency, memory, bundle size or resource use",
		);
		await expect(body.getByText("Glyph must be one character.")).toBeVisible();
		await expect(body.getByTestId("surfacing-category-apply")).toBeDisabled();
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};
export const CategoryEditorLight: Story = {
	...CategoryEditor,
	globals: { theme: "light" },
};

export const StaleDraft: Story = {
	play: async (context) => {
		await categories(context);
		fixture.changeElsewhere();
		const body = within(context.canvasElement.ownerDocument.body);
		await userEvent.click(
			within(body.getByTestId("surfacing-draft-bar")).getByRole("button", {
				name: "Save",
			}),
		);
		await expect(
			body.getByText("Categories changed elsewhere", { exact: true }),
		).toBeVisible();
		await expect(
			body.getByRole("spinbutton", { name: "Finding weight" }),
		).toHaveValue(45);
		await waitFor(() =>
			expect(body.getByTestId("surfacing-category-preview")).toHaveTextContent(
				"No judged messages yet",
			),
		);
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};
export const StaleDraftLight: Story = {
	...StaleDraft,
	globals: { theme: "light" },
};

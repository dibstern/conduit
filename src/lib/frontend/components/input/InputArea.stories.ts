import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
	phaseToProcessing,
} from "../../stores/chat.svelte.js";
import { discoveryState } from "../../stores/discovery.svelte.js";
import { fileTreeState } from "../../stores/file-tree.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import InputArea from "./InputArea.svelte";

const testId = "story-input";
const fileEntries = [
	"README.md",
	"src/index.ts",
	...Array.from({ length: 20 }, (_, index) => `src/generated/file-${index}.ts`),
];

async function assertSwapStyles(
	canvasElement: HTMLElement,
	surface: HTMLElement,
	consumer: "FileMenu" | "CommandMenu",
) {
	const radiusProbe = document.createElement("div");
	radiusProbe.className = "rounded-xl";
	const dropdownProbe = document.createElement("div");
	dropdownProbe.className = "z-[var(--z-dropdown)]";
	const popoverProbe = document.createElement("div");
	popoverProbe.className = "z-[var(--z-popover)]";
	canvasElement.append(radiusProbe, dropdownProbe, popoverProbe);

	try {
		const surfaceStyle = getComputedStyle(surface);
		const radius = getComputedStyle(radiusProbe).borderRadius;
		const dropdownZIndex = getComputedStyle(dropdownProbe).zIndex;
		const popoverZIndex = getComputedStyle(popoverProbe).zIndex;
		console.log(
			`[swap-style] ${consumer} borderRadius=${surfaceStyle.borderRadius} reference=${radius}; zIndex=${surfaceStyle.zIndex} dropdownReference=${dropdownZIndex} popoverReference=${popoverZIndex}`,
		);
		await expect(surfaceStyle.borderRadius).toBe(radius);
		await expect(surfaceStyle.zIndex).toBe(dropdownZIndex);
		await expect(surfaceStyle.zIndex).not.toBe(popoverZIndex);
	} finally {
		radiusProbe.remove();
		dropdownProbe.remove();
		popoverProbe.remove();
	}
}

function setupDiscovery() {
	discoveryState.providers = [
		{
			id: "anthropic",
			name: "Anthropic",
			models: [
				{
					id: "claude-sonnet-4-20250514",
					name: "Claude Sonnet 4",
					provider: "anthropic",
					variants: ["low", "medium", "high"],
				},
			],
			configured: true,
		},
	];
	discoveryState.currentModelId = "claude-sonnet-4-20250514";
	discoveryState.currentProviderId = "anthropic";
	discoveryState.currentVariant = "high";
	discoveryState.availableVariants = ["low", "medium", "high"];
	discoveryState.agents = [
		{ id: "code", name: "code", description: "Write and edit code" },
	];
	discoveryState.activeAgentId = "code";
	discoveryState.commands = [
		{ name: "review", description: "Review a pull request" },
		{ name: "compact", description: "Compact conversation history" },
		{ name: "config", description: "View configuration" },
	];
}

const meta = {
	title: "Input/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		sessionState.currentId = testId;
		phaseToIdle();
		getOrCreateSessionActivity(testId).phase = "idle";
		getOrCreateSessionMessages(testId).contextPercent = 0;
		setupDiscovery();
		fileTreeState.entries = fileEntries;
		fileTreeState.loading = false;
		fileTreeState.loaded = true;
	},
} satisfies Meta<typeof InputArea>;

export default meta;
type Story = StoryObj<typeof meta>;

// The composer stories opt into a strict axe gate for the mention-menu ARIA. One rule is
// excluded, and the exclusion is not a judgement about the rule — it names a decision that
// is open elsewhere, so enabling it here would silently make that decision. Everything else
// stays strict, and the rule remains live repo-wide.
//
//   color-contrast    The composer chrome (.model-label, the variant and permission badges)
//                     already fails at #71717a on #27272a/#333338 today, independently of
//                     this change — verified: the diff contains zero references to those
//                     selectors. That is conduit-test-de3.28.2's contrast floor, which is
//                     gated on a pending colour decision. Expires when de3.28.2 lands.
//   scrollable-region-focusable
//                     Direct, measured consequence of dropping the role — not a pre-existing
//                     failure. axe exempts a scrollable listbox from this rule only when it
//                     is a *combobox popup*, and its `isComboboxPopup` helper decides that by
//                     looking for a `[role~="combobox"][aria-controls~=<id>]` owner. With the
//                     role gone the exemption goes with it, and the menus are `max-h-[300px]
//                     overflow-y-auto`. The two available fixes are both worse: restoring the
//                     role reinstates `aria-allowed-role`, and `tabindex="0"` on the listbox
//                     is the second, wrong tab stop DetachedListbox forbids by construction.
//                     SC 2.1.1 is met by the route axe cannot see — ArrowUp/ArrowDown scroll
//                     the active row from the textarea, asserted below via scrollIntoView.
//                     Tracked: conduit-test-n9s.
//
// `aria-allowed-role` was excluded here until conduit-test-n9s settled. It no longer is:
// n9s.1 measured both candidate markups in a real browser and found `role="combobox"` on a
// <textarea> to be the sole violation, so the composer dropped the role (option 3C) rather
// than keep the exclusion. The rule is live below, and it is the gate that keeps it dropped.
const STRICT_ARIA = {
	a11y: {
		test: "error",
		config: {
			rules: [
				{ id: "color-contrast", enabled: false },
				{ id: "scrollable-region-focusable", enabled: false },
			],
		},
	},
} as const;

export const Empty: Story = {};

export const Processing: Story = {
	beforeEach: () => {
		phaseToProcessing();
		getOrCreateSessionActivity(testId).phase = "processing";
		// Ensure discovery state persists through processing state change
		discoveryState.currentVariant = "high";
	},
};

export const WithContextBar: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 42;
	},
};

export const HighContext: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 85;
	},
};

export const CriticalContext: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 97;
	},
};

export const Hover: Story = {
	...Empty,
	parameters: { pseudo: { hover: true } },
};

export const FileMenuInteraction: Story = {
	parameters: STRICT_ARIA,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const textarea = canvas.getByRole("textbox", { name: "Message" });
		const status = canvas.getByTestId("composer-menu-status");
		const originalScrollIntoView = Element.prototype.scrollIntoView;
		const scrollIntoView = fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		try {
			await userEvent.click(textarea);
			await userEvent.type(textarea, "@");
			const listbox = await canvas.findByRole("listbox", {
				name: "File suggestions",
			});
			await expect(textarea).toHaveFocus();
			await expect(
				document.getElementById(textarea.getAttribute("aria-controls") ?? ""),
			).toBe(listbox);

			let options = canvas.getAllByRole("option");
			// The composer is a plain textbox (option 3C), so "a menu opened" is spoken by
			// a live region rather than read off aria-expanded. Asserted against the real
			// option count, so a stale or stuck message fails here rather than passing on
			// the mere presence of text.
			await expect(status).toHaveTextContent(
				`${options.length} files available`,
			);
			await expect(options[0]).toHaveAttribute("aria-selected", "true");
			await expect(
				document.getElementById(
					textarea.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(options[0]);

			await userEvent.keyboard("{ArrowDown}");
			await waitFor(() => {
				options = canvas.getAllByRole("option");
				expect(options[1]).toHaveAttribute("aria-selected", "true");
				expect(textarea).toHaveFocus();
				expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
				expect(listbox.contains(options[1] as HTMLElement)).toBe(true);
			});

			await assertSwapStyles(canvasElement, listbox, "FileMenu");
			await userEvent.keyboard("{Tab}");
			await expect(textarea).toHaveValue("@src/index.ts ");
			await expect(textarea).toHaveFocus();
			await expect(textarea).not.toHaveAttribute("aria-controls");
			await expect(status.textContent?.trim()).toBe("");
			await expect(
				canvas.queryByRole("listbox", { name: "File suggestions" }),
			).toBeNull();

			await userEvent.clear(textarea);
			await userEvent.type(textarea, "@");
			await userEvent.keyboard("{Escape}");
			await expect(textarea).toHaveValue("");
			await expect(textarea).toHaveFocus();
			await expect(
				canvas.queryByRole("listbox", { name: "File suggestions" }),
			).toBeNull();

			await userEvent.type(textarea, "@src");
			options = await canvas.findAllByRole("option");
			await expect(options.length).toBeGreaterThan(1);
			for (const option of options) {
				await expect(option.textContent?.toLowerCase()).toContain("src");
			}
			await userEvent.click(options[0] as HTMLElement);
			await expect(textarea).toHaveFocus();
		} finally {
			Element.prototype.scrollIntoView = originalScrollIntoView;
		}
	},
};

export const FileMenuLoading: Story = {
	// This story's baseline shows the composer only, never the loading menu, and
	// that is not fixable by capture mode: FileMenu is a drop-up (`bottom-full`)
	// and `layout: "fullscreen"` pins the composer to the top of the canvas, so
	// the surface renders at negative y and is clipped off-viewport. Measured, not
	// assumed — tagging `viewport-capture` and re-capturing full-page produces the
	// same composer with empty space below it. The visual coverage of the loading
	// surface lives in `input-filemenu--loading`, which holds committed baselines
	// and passes at zero tolerance; what this story uniquely covers is the
	// composer-level ARIA below, which is behavioural and needs no pixels.
	parameters: STRICT_ARIA,
	beforeEach: () => {
		fileTreeState.entries = [];
		fileTreeState.loading = true;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const textarea = canvas.getByRole("textbox", { name: "Message" });
		const status = canvas.getByTestId("composer-menu-status");
		await userEvent.click(textarea);
		await userEvent.type(textarea, "@");
		const listbox = await canvas.findByRole("listbox", {
			name: "File suggestions",
		});
		await expect(listbox).toHaveAttribute("aria-busy", "true");
		await expect(status).toHaveTextContent("Loading files");
		await expect(textarea).not.toHaveAttribute("aria-activedescendant");
		await expect(canvas.queryByRole("option")).toBeNull();
	},
};

export const CommandMenuInteraction: Story = {
	parameters: STRICT_ARIA,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const textarea = canvas.getByRole("textbox", { name: "Message" });
		const status = canvas.getByTestId("composer-menu-status");
		const originalScrollIntoView = Element.prototype.scrollIntoView;
		const scrollIntoView = fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		try {
			await userEvent.click(textarea);
			await userEvent.type(textarea, "/");
			const listbox = await canvas.findByRole("listbox", {
				name: "Slash commands",
			});
			await expect(textarea).toHaveFocus();
			await expect(
				document.getElementById(textarea.getAttribute("aria-controls") ?? ""),
			).toBe(listbox);
			await expect(document.querySelectorAll("#command-menu")).toHaveLength(1);
			await expect(
				document.querySelectorAll("#command-menu-wrap"),
			).toHaveLength(1);

			let options = canvas.getAllByRole("option");
			await expect(status).toHaveTextContent(
				`${options.length} commands available`,
			);
			await expect(options[0]).toHaveAttribute("aria-selected", "true");
			await expect(
				document.getElementById(
					textarea.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(options[0]);

			await userEvent.keyboard("{ArrowDown}");
			await waitFor(() => {
				options = canvas.getAllByRole("option");
				expect(options[1]).toHaveAttribute("aria-selected", "true");
				expect(textarea).toHaveFocus();
				expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
				expect(listbox.contains(options[1] as HTMLElement)).toBe(true);
			});

			await assertSwapStyles(canvasElement, listbox, "CommandMenu");
			await userEvent.keyboard("{Tab}");
			await expect(textarea).toHaveValue("/config ");
			await expect(textarea).toHaveFocus();
			await expect(textarea).not.toHaveAttribute("aria-controls");
			await expect(status.textContent?.trim()).toBe("");
			await expect(
				canvas.queryByRole("listbox", { name: "Slash commands" }),
			).toBeNull();

			await userEvent.clear(textarea);
			await userEvent.type(textarea, "/");
			await userEvent.keyboard("{Escape}");
			await expect(textarea).toHaveValue("");
			await expect(textarea).toHaveFocus();
			await expect(
				canvas.queryByRole("listbox", { name: "Slash commands" }),
			).toBeNull();

			await userEvent.type(textarea, "/co");
			options = await canvas.findAllByRole("option");
			await expect(
				options.map((option) =>
					option.querySelector(".cmd-name")?.textContent?.trim(),
				),
			).toEqual(["/compact", "/config"]);
			await userEvent.click(options[0] as HTMLElement);
			await expect(textarea).toHaveFocus();
		} finally {
			Element.prototype.scrollIntoView = originalScrollIntoView;
		}
	},
};

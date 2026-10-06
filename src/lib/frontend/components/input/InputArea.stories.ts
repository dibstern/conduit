import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { SessionGoalChangedPayload } from "../../../contracts/stored-event.js";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
	phaseToProcessing,
} from "../../stores/chat.svelte.js";
import {
	composerPreferences,
	setComposerPreferences,
} from "../../stores/composer-preferences.svelte.js";
import {
	clearDiscoveryState,
	discoveryState,
	handleAgentList,
	handleCommandList,
	handleContextWindowInfo,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	handleVariantInfo,
} from "../../stores/discovery.svelte.js";
import { fileTreeState } from "../../stores/file-tree.svelte.js";
import { handleGoalChanged, sessionGoals } from "../../stores/goal.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
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
	radiusProbe.className = "rounded-lg";
	const dropdownProbe = document.createElement("div");
	dropdownProbe.className = "z-[var(--z-dropdown)]";
	const popoverProbe = document.createElement("div");
	popoverProbe.className = "z-[var(--z-popover)]";
	// The swap dropped the consumer's own `bg-bg-surface` in favour of
	// FLOATING_SURFACE_CLASSES' `bg-bg-alt`. Back then the two
	// tokens resolved identically, so a second probe asserted their equality --
	// deliberately, to go red the day they diverged. They have now diverged: the
	// approved palette puts every surface that FLOATS over content on --alt and
	// every INSET control on --surface. So the equality
	// probe is gone and the one below carries the load on its own: pinning the
	// listbox to bg-alt exactly is what catches a slide back to bg-surface.
	const surfaceBgProbe = document.createElement("div");
	surfaceBgProbe.className = "bg-bg-alt";
	canvasElement.append(
		radiusProbe,
		dropdownProbe,
		popoverProbe,
		surfaceBgProbe,
	);

	try {
		const surfaceStyle = getComputedStyle(surface);
		const radius = getComputedStyle(radiusProbe).borderRadius;
		const dropdownZIndex = getComputedStyle(dropdownProbe).zIndex;
		const popoverZIndex = getComputedStyle(popoverProbe).zIndex;
		const surfaceBg = getComputedStyle(surfaceBgProbe).backgroundColor;
		console.log(
			`[swap-style] ${consumer} borderRadius=${surfaceStyle.borderRadius} reference=${radius}; zIndex=${surfaceStyle.zIndex} dropdownReference=${dropdownZIndex} popoverReference=${popoverZIndex}; backgroundColor=${surfaceStyle.backgroundColor} bgAltReference=${surfaceBg}`,
		);
		await expect(surfaceStyle.borderRadius).toBe(radius);
		await expect(surfaceStyle.zIndex).toBe(dropdownZIndex);
		await expect(surfaceStyle.zIndex).not.toBe(popoverZIndex);
		await expect(surfaceStyle.backgroundColor).toBe(surfaceBg);
	} finally {
		radiusProbe.remove();
		dropdownProbe.remove();
		popoverProbe.remove();
		surfaceBgProbe.remove();
	}
}

function setHighVariant() {
	handleVariantInfo({
		variant: "high",
		variants: ["low", "medium", "high"],
	});
}

function setupDiscovery() {
	handleModelList({
		providers: [
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
		],
	});
	handleModelInfo({
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
	});
	setHighVariant();
	handleAgentList({
		providerScope: { id: "anthropic", name: "Anthropic" },
		agents: [{ id: "code", name: "code", description: "Write and edit code" }],
		activeAgentId: "code",
	});
	handleCommandList({
		commands: [
			{ name: "review", description: "Review a pull request" },
			{ name: "compact", description: "Compact conversation history" },
			{ name: "config", description: "View configuration" },
		],
	});
}

const meta = {
	title: "Input/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		setComposerPreferences({ controls: "icons", contextWarning: 80 });
		sessionState.currentId = testId;
		phaseToIdle(getOrCreateSessionActivity(testId));
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
//                     selectors. That is a separate contrast floor for those colours.
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
//
// `aria-allowed-role` was previously excluded here. It no longer is:
// Browser checks measured both candidate markups and found `role="combobox"` on a
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

function setupWords(phone: boolean) {
	const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
	const path = routerState.path;
	const root = document.getElementById("storybook-root");
	const style = root?.getAttribute("style");
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: phone ? 393 : 1440,
	});
	window.dispatchEvent(new Event("resize"));
	root?.setAttribute(
		"style",
		`display:flex;flex-direction:column;justify-content:flex-end;min-height:100vh;max-width:${phone ? "393px" : "none"}`,
	);
	routerState.path = "/";
	clearDiscoveryState();
	const contextWindowOptions = [
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M" },
	];
	handleModelList({
		providers: [
			{
				id: "claude",
				name: "Claude",
				configured: true,
				models: [
					{
						id: "claude-sonnet-5",
						name: "Sonnet 5",
						provider: "claude",
						contextWindowOptions,
					},
				],
			},
		],
	});
	handleModelInfo({
		model: "claude-sonnet-5",
		provider: "claude",
	});
	handleDefaultModelInfo({
		model: "claude-sonnet-5",
		provider: "claude",
		variant: "",
	});
	handleContextWindowInfo({
		contextWindow: "200k",
		options: contextWindowOptions,
	});
	handleVariantInfo({
		variant: "high",
		variants: ["low", "medium", "high", "xhigh", "max"],
	});
	getOrCreateSessionMessages(testId).contextPercent = 42;
	setComposerPreferences({ controls: "words" });
	return () => {
		setComposerPreferences({ controls: "icons" });
		clearDiscoveryState();
		routerState.path = path;
		if (width) Object.defineProperty(window, "innerWidth", width);
		else Reflect.deleteProperty(window, "innerWidth");
		window.dispatchEvent(new Event("resize"));
		if (style != null) root?.setAttribute("style", style);
		else root?.removeAttribute("style");
	};
}

export const WordsDesktop: Story = {
	tags: ["autodocs"],
	globals: { theme: "dark" },
	beforeEach: () => setupWords(false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const row = canvas.getByTestId("composer-words-row");
		await expect(row).toBeVisible();
		await expect(row.querySelector(".glyph")).toBeNull();
		await expect(canvas.getByTestId("composer-word-model")).toHaveTextContent(
			"Sonnet 5",
		);
		await expect(canvas.getByTestId("composer-word-context")).toHaveTextContent(
			"200K",
		);
		await expect(canvas.getByTestId("composer-word-effort")).toHaveTextContent(
			"high",
		);
		await expect(
			canvas.getByTestId("composer-word-approvals"),
		).toHaveTextContent("ask");
		await expect(
			canvas.getByTestId("composer-word-context-usage"),
		).toHaveTextContent("42%");
		await expect(canvas.queryByTestId("model-picker-trigger")).toBeNull();
		await expect(canvas.queryByTestId("variant-badge")).toBeNull();
		await expect(canvas.queryByTestId("permission-mode-badge")).toBeNull();
		const composer = canvasElement.querySelector("#input-row");
		if (!composer) throw new Error("Composer is missing");
		await expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			composer.getBoundingClientRect().bottom,
		);
		await userEvent.click(canvas.getByTestId("composer-word-effort"));
		await expect(canvas.getByTestId("composer-word-effort")).toHaveTextContent(
			"xhigh",
		);
		await expect(body.queryByTestId("variant-dropdown")).toBeNull();
		await userEvent.click(canvas.getByTestId("composer-word-model"));
		await expect(await body.findByTestId("model-picker")).toBeVisible();
		await expect(body.getByTestId("picker-row-model")).toHaveTextContent(
			"Sonnet 5",
		);
		// The phone sheet is a native <dialog>: a real Escape fires its cancel
		// event, but a synthetic keypress never reaches the browser's handler.
		const sheet = canvasElement.ownerDocument.querySelector("dialog[open]");
		if (sheet) sheet.dispatchEvent(new Event("cancel", { cancelable: true }));
		else await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(body.queryByTestId("model-picker")).toBeNull());
		await expect(composerPreferences.controls).toBe("words");
	},
};

export const WordsDesktopLight: Story = {
	...WordsDesktop,
	tags: ["autodocs"],
	globals: { theme: "light" },
};

export const WordsPhone: Story = {
	...WordsDesktop,
	tags: ["autodocs"],
	parameters: { phone: true },
	beforeEach: () => setupWords(true),
};

export const WordsPhoneLight: Story = {
	...WordsPhone,
	tags: ["autodocs"],
	globals: { theme: "light" },
};

// The composer clock times the prompt that started the turn.
function startTurn() {
	const chat = getOrCreateSessionMessages(testId);
	chat.messages = [
		{
			type: "user",
			uuid: "story-prompt",
			messageId: "story-prompt",
			text: "Run the suite",
			turnTiming: { startedAt: Date.now(), waits: [] },
		},
	];
	phaseToProcessing(getOrCreateSessionActivity(testId));
	return () => {
		chat.messages = [];
	};
}

export const Processing: Story = {
	beforeEach: () => {
		const cleanup = startTurn();
		// Ensure discovery state persists through processing state change
		setHighVariant();
		return cleanup;
	},
};

let goalStorySetAt = Date.now() - 41 * 60_000;

function setupGoal(
	state: "checking" | "not_yet" | "not_yet_idle" | "paused" | "met" | "cleared",
) {
	const previous = sessionGoals.get(testId);
	const model = discoveryState.currentModelId;
	const provider = discoveryState.currentProviderId;
	handleModelInfo({ model, provider: "claude" });
	goalStorySetAt = Math.max(goalStorySetAt + 1, Date.now() - 41 * 60_000);
	const activeGoal = {
		condition: "All 38 scenarios pass",
		iterations: 2,
		setAt: goalStorySetAt,
		tokensAtStart: 0,
	};
	const facts: SessionGoalChangedPayload =
		state === "met" || state === "cleared"
			? {
					sessionId: testId,
					goal: null,
					ended: state,
					endedAt:
						state === "met" ? activeGoal.setAt + 41 * 60_000 : Date.now(),
					endedGoal: {
						...activeGoal,
						iterations: 7,
						lastReason: "38 of 38 scenarios pass",
					},
				}
			: {
					sessionId: testId,
					goal: {
						...activeGoal,
						...(state === "not_yet" || state === "not_yet_idle"
							? { lastReason: "35 of 38 scenarios pass" }
							: {}),
					},
					...(state === "paused"
						? { pausedReason: "Goal check interrupted" }
						: {}),
				};
	handleGoalChanged(facts);
	const endTurn = state === "not_yet" ? startTurn() : undefined;
	if (!endTurn) phaseToIdle(getOrCreateSessionActivity(testId));
	return () => {
		endTurn?.();
		if (previous) handleGoalChanged(previous);
		else sessionGoals.delete(testId);
		handleModelInfo({ model, provider });
		localStorage.removeItem(
			`conduit:goal-met-dismissed:${testId}:${activeGoal.setAt}`,
		);
	};
}

export const GoalChecking: Story = {
	beforeEach: () => setupGoal("checking"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-status-header"),
		).toHaveTextContent("Checking goal · check 3");
		await expect(
			canvas.queryByTestId("composer-status-elapsed"),
		).not.toBeInTheDocument();
		const row = canvasElement.querySelector("#input-row");
		if (!row) throw new Error("Composer is missing");
		const style = getComputedStyle(row);
		const expected = new Option().style;
		expected.color = style.getPropertyValue("--color-status-violet");
		await expect(style.borderColor).toBe(expected.color);
		await expect(style.borderStyle).toBe("solid");
	},
};

export const GoalNotYetWorking: Story = {
	beforeEach: () => setupGoal("not_yet"),
	play: async ({ canvasElement }) => {
		// The reason lives in the goal details; the composer stays one line.
		await expect(
			within(canvasElement).getByTestId("composer-status-header"),
		).not.toHaveTextContent("35 of 38 scenarios pass");
	},
};

export const GoalNotYetIdle: Story = {
	beforeEach: () => setupGoal("not_yet_idle"),
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).queryByTestId("composer-status-header"),
		).not.toBeInTheDocument();
	},
};

export const GoalPaused: Story = {
	beforeEach: () => setupGoal("paused"),
	play: async ({ canvasElement }) => {
		const row = canvasElement.querySelector("#input-row");
		if (!row) throw new Error("Composer is missing");
		await expect(getComputedStyle(row).borderStyle).toBe("dashed");
		await expect(getComputedStyle(row).boxShadow).toBe("none");
		await expect(
			within(canvasElement).queryByTestId("composer-status-header"),
		).not.toBeInTheDocument();
	},
};

export const GoalMet: Story = {
	beforeEach: () => setupGoal("met"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("composer-goal-met");
		await expect(bar).toHaveTextContent(
			"Goal met · 38 of 38 scenarios pass · 7 checks · 41m",
		);
		await expect(
			within(bar).getByTestId("composer-goal-met-details"),
		).toBeEnabled();
		await expect(
			within(bar).getByRole("button", { name: "Dismiss" }),
		).toBeEnabled();
	},
};

export const GoalMetDismissed: Story = {
	beforeEach: () => setupGoal("met"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("composer-goal-met");
		await userEvent.click(within(bar).getByRole("button", { name: "Dismiss" }));
		await expect(
			canvas.queryByTestId("composer-goal-met"),
		).not.toBeInTheDocument();
		const facts = sessionGoals.get(testId);
		if (!facts?.endedGoal) throw new Error("Ended goal is missing");
		await expect(
			localStorage.getItem(
				`conduit:goal-met-dismissed:${testId}:${facts.endedGoal.setAt}`,
			),
		).toBe("true");
	},
};

export const GoalCleared: Story = {
	beforeEach: () => setupGoal("cleared"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("composer-goal-cleared")).toHaveTextContent(
			"Goal cleared",
		);
		await expect(canvas.getByRole("button", { name: "Undo" })).toBeEnabled();
	},
};

export const GoalCheckingLight: Story = {
	...GoalChecking,
	globals: { theme: "light" },
};
export const GoalNotYetWorkingLight: Story = {
	...GoalNotYetWorking,
	globals: { theme: "light" },
};
export const GoalNotYetIdleLight: Story = {
	...GoalNotYetIdle,
	globals: { theme: "light" },
};
export const GoalPausedLight: Story = {
	...GoalPaused,
	globals: { theme: "light" },
};
export const GoalMetLight: Story = { ...GoalMet, globals: { theme: "light" } };
export const GoalMetDismissedLight: Story = {
	...GoalMetDismissed,
	globals: { theme: "light" },
};
export const GoalClearedLight: Story = {
	...GoalCleared,
	globals: { theme: "light" },
};

export const WithContextBar: Story = {
	beforeEach: () => {
		setComposerPreferences({ controls: "words" });
		getOrCreateSessionMessages(testId).contextPercent = 42;
	},
};

export const HighContext: Story = {
	beforeEach: () => {
		setComposerPreferences({ controls: "words" });
		getOrCreateSessionMessages(testId).contextPercent = 85;
	},
};

export const CriticalContext: Story = {
	beforeEach: () => {
		setComposerPreferences({ controls: "words" });
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

import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { Effect } from "effect";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
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
	applyGetModelsResponse,
	chooseVariant,
	clearDiscoveryState,
	discoveryState,
	getSessionPick,
	handleAgentList,
	handleCommandList,
	handleDefaultModelInfo,
} from "../../stores/discovery.svelte.js";
import { fileTreeState } from "../../stores/file-tree.svelte.js";
import { handleGoalChanged, sessionGoals } from "../../stores/goal.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { turn as readTurn } from "../../stores/turn.svelte.js";
import { usageState } from "../../stores/usage.svelte.js";
import { mockClaudeAccount, mockOpenCodeAccount } from "../../stories/mocks.js";
import { connectedSocket } from "../../stories/sockets.js";
import { runTransportEffect } from "../../transport/runtime.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import { WsRpcClients } from "../../transport/shared-client.js";
import type { OpenCodeInstance } from "../../types.js";
import {
	insertComposerReference,
	type ReplyReference,
} from "./composer-reference.svelte.js";
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
	// FLOATING_SURFACE_CLASSES' floating fill. Every floating surface wears the
	// Final --pop step (`bg-popover-bg`) and every INSET control --surface, so
	// pinning the listbox to popover-bg exactly catches a slide back.
	const surfaceBgProbe = document.createElement("div");
	surfaceBgProbe.className = "bg-popover-bg";
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
	chooseVariant("high");
}

function setupDiscovery() {
	applyGetModelsResponse(
		{
			projectSlug: "conduit",
			instanceId: "opencode",
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
			active: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
			variant: { variant: "high", variants: ["low", "medium", "high"] },
			contextWindow: { contextWindow: "", options: [] },
			permissionMode: "ask",
		},
		testId,
	);
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

/** The composer names the session's account, so the session needs a row. */
function seedSessionAccount(account: OpenCodeInstance): void {
	instanceState.instances = [account];
	applySessionChange({
		_tag: "snapshot",
		sequence: Date.now(),
		rows: [
			{
				accountId: account.id,
				id: testId,
				projectSlug: "conduit",
				title: "Composer",
				status: "idle",
			},
		],
	});
}

const meta = {
	title: "Input/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		const sessions = [...sessionState.sessions.values()];
		const instances = instanceState.instances;
		setComposerPreferences({ controls: "icons", contextWarning: 80 });
		seedSessionAccount(mockOpenCodeAccount);
		sessionState.currentId = testId;
		phaseToIdle(getOrCreateSessionActivity(testId));
		getOrCreateSessionMessages(testId).contextPercent = 0;
		setupDiscovery();
		fileTreeState.entries = fileEntries;
		fileTreeState.loading = false;
		fileTreeState.loaded = true;
		// A real socket never opens under a static server and would hold every
		// later dial in "Connecting".
		const restoreSocket = connectedSocket();
		return () => {
			restoreSocket();
			instanceState.instances = instances;
			applySessionChange({
				_tag: "snapshot",
				sequence: Date.now(),
				rows: sessions,
			});
		};
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
export const EmptyLight: Story = { globals: { theme: "light" } };

const replyAsk: ReplyReference = {
	kind: "message",
	ordinal: 24,
	category: "Ask",
	glyph: "?",
	time: "31:02",
	text: "The phone sidebar baseline shifts 2px because the unread badge now paints before the first frame. Recapture it, or keep the old paint order?",
};

async function showReferences(
	canvasElement: HTMLElement,
	references: ReplyReference[],
) {
	const canvas = within(canvasElement);
	const input = canvas.getByRole<HTMLTextAreaElement>("textbox", {
		name: "Message",
	});
	for (const [index, reference] of references.entries()) {
		insertComposerReference(reference, testId);
		await waitFor(() =>
			expect(canvas.getAllByTestId("surfacing-ref-token")).toHaveLength(
				index + 1,
			),
		);
		await waitFor(() => expect(input.selectionStart).toBe(input.value.length));
	}
	await userEvent.type(input, "Recapture it. The 2px shift is expected.");
	await userEvent.click(
		canvas.getByRole("button", { name: "What the agent receives" }),
	);
	// Back to the draft, as a user would, so the header's focus ring is not drawn.
	input.focus();
	await expect(canvas.getAllByTestId("surfacing-ref-token")).toHaveLength(
		references.length,
	);
}

export const ReplyReferences: Story = {
	play: async ({ canvasElement }) => showReferences(canvasElement, [replyAsk]),
};
export const ReplyReferencesLight: Story = {
	...ReplyReferences,
	globals: { theme: "light" },
};
export const ReplyExcerpt: Story = {
	play: async ({ canvasElement }) =>
		showReferences(canvasElement, [
			{
				...replyAsk,
				kind: "excerpt",
				text: "The phone sidebar baseline shifts 2px because the unread badge now paints before the first frame.",
			},
		]),
};
export const ReplyExcerptNarrow: Story = {
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole<HTMLTextAreaElement>(
			"textbox",
			{ name: "Message" },
		);
		const field = input.parentElement as HTMLElement;
		field.style.width = "220px";
		await showReferences(canvasElement, [
			{
				...replyAsk,
				kind: "excerpt",
				text: "这是用于检查窄屏幕自动换行的中文引用内容请保留完整文字。",
			},
		]);
		const mirror = field.querySelector(".mirror") as HTMLElement;
		await expect(input.getBoundingClientRect().width).toBe(220);
		await expect(getComputedStyle(mirror).whiteSpace).toBe(
			getComputedStyle(input).whiteSpace,
		);
		await waitFor(() =>
			expect(
				Math.abs(input.scrollHeight - mirror.getBoundingClientRect().height),
			).toBeLessThanOrEqual(1),
		);
		await expect(mirror.scrollWidth).toBeLessThanOrEqual(mirror.clientWidth);
	},
};
export const ReplyRecap: Story = {
	play: async ({ canvasElement }) =>
		showReferences(canvasElement, [
			{
				kind: "recap-excerpt",
				text: "The badge paints before the first frame.",
			},
		]),
};
export const ReplyMultiple: Story = {
	play: async ({ canvasElement }) =>
		showReferences(canvasElement, [
			replyAsk,
			{
				kind: "excerpt",
				ordinal: 18,
				category: "Decision",
				glyph: "◆",
				time: "22:40",
				text: "one subscribeSessionSummaries stream",
			},
		]),
};
export const ReplyReferencesPhone: Story = {
	globals: { viewport: { value: "mobile1", isRotated: false } },
	beforeEach: ({ canvasElement }) => setupWords(canvasElement, true),
	play: async ({ canvasElement }) => showReferences(canvasElement, [replyAsk]),
};
export const ReplyAtomicEditing: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByRole<HTMLTextAreaElement>("textbox", {
			name: "Message",
		});
		// The textarea's text for the token: no-break inside, narrow padding outside.
		const label = "\u202f?\u00a0#24\u00a0Ask\u00a0×\u202f";
		await userEvent.type(input, "Before  after");
		input.setSelectionRange(7, 7);
		insertComposerReference(replyAsk, testId);
		await waitFor(() => expect(input.value).toBe(`Before ${label} after`));
		await waitFor(() =>
			expect(input.selectionStart).toBe(`Before ${label} `.length),
		);
		// The caret steps over the space, then over the whole token.
		await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
		await expect(input.selectionStart).toBe(7);
		await userEvent.type(input, "left ", { skipClick: true });
		await expect(input.value).toBe(`Before left ${label} after`);
		await userEvent.click(canvas.getByTestId("surfacing-ref-remove"));
		await expect(input.value).toBe("Before left after");
		await waitFor(() =>
			expect(input.selectionStart).toBe("Before left ".length),
		);
		insertComposerReference(replyAsk, testId);
		await waitFor(() => expect(input.value).toBe(`Before left ${label} after`));
		await waitFor(() =>
			expect(input.selectionStart).toBe(`Before left ${label} `.length),
		);
		await userEvent.keyboard("{ArrowLeft}{Backspace}");
		await expect(
			canvas.queryByTestId("surfacing-ref-token"),
		).not.toBeInTheDocument();
		await expect(input.value).toBe("Before left  after");
	},
};

/**
 * Text inserted in one go past the height cap, the way IME commits, dictation
 * and `insertText` deliver it: the browser reveals the caret before the mirror
 * has grown the row, so the composer itself has to bring the caret's line into
 * its scroll window. The textarea never scrolls on its own, which keeps the
 * highlight mirror (which never scrolls either) under it.
 */
export const OverflowingInsert: Story = {
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole<HTMLTextAreaElement>(
			"textbox",
			{ name: "Message" },
		);
		const mirror = textarea.parentElement?.querySelector(
			"[aria-hidden='true']",
		);
		const scroller = textarea.parentElement?.parentElement;
		if (!mirror || !scroller) throw new Error("composer layers not found");
		textarea.focus();
		// The native editing path (unlike userEvent, which sets the value from JS).
		document.execCommand(
			"insertText",
			false,
			Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
		);

		// The caret is on the draft's last line.
		const expectCaretOnLastLineVisible = () =>
			waitFor(() => {
				const style = getComputedStyle(textarea);
				const box = textarea.getBoundingClientRect();
				const view = scroller.getBoundingClientRect();
				const caretBottom = box.bottom - parseFloat(style.paddingBottom);
				const caretTop = caretBottom - parseFloat(style.lineHeight);
				expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
				expect(caretTop).toBeGreaterThanOrEqual(view.top - 1);
				expect(caretBottom).toBeLessThanOrEqual(view.bottom + 1);
				expect(textarea.scrollTop).toBe(0);
				expect(mirror.getBoundingClientRect().toJSON()).toEqual(box.toJSON());
			});
		await expectCaretOnLastLineVisible();

		// A mid-word insert that wraps its word onto a new last line: the text
		// after the caret decides where the caret lands. Pad a final line until
		// its word sits on the wrap boundary, then grow the word from its middle.
		const word = "bbbbbbbb";
		document.execCommand("insertText", false, `\n ${word}`);
		const lineStart = textarea.value.length - word.length - 1;
		const rows = () => mirror.getBoundingClientRect().height;
		const flush = () => new Promise(requestAnimationFrame);
		await flush();
		const height = rows();
		while (rows() === height) {
			textarea.setSelectionRange(lineStart, lineStart);
			document.execCommand("insertText", false, "a");
			await flush();
		}
		document.execCommand("delete");
		await flush();
		const middle = textarea.value.length - word.length / 2;
		textarea.setSelectionRange(middle, middle);
		document.execCommand("insertText", false, "bbbb");
		await waitFor(() => expect(rows()).toBeGreaterThan(height));
		await expectCaretOnLastLineVisible();
	},
};

function setupWords(canvasElement: HTMLElement, phone: boolean) {
	const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
	const path = routerState.path;
	const sessions = [...sessionState.sessions.values()];
	const projects = projectState.projects;
	const instances = instanceState.instances;
	const traits = instanceState.providerTraits;
	const compact = sessionViewState.compact;
	const composerWidth = sessionViewState.composerWidth;
	const style = canvasElement.getAttribute("style");
	// The app dials its RPC socket at startup. Left to the picker's first read,
	// the dial flips the composer to "Connecting" and takes the picker away.
	void runTransportEffect(
		Effect.flatMap(WsRpcClients, (clients) => clients.forProject("conduit")),
	);
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: phone ? 393 : 1440,
	});
	window.dispatchEvent(new Event("resize"));
	canvasElement.setAttribute(
		"style",
		`display:flex;flex-direction:column;justify-content:flex-end;min-height:100vh;max-width:${phone ? "393px" : "none"}`,
	);
	const claudeTraits = getProviderDriver("claude");
	if (!claudeTraits) throw new Error("Claude driver traits are missing");
	instanceState.providerTraits = {
		...traits,
		claude: { ...claudeTraits, supportsGoalState: true },
	};
	// The route is the only record of the open session.
	routerState.path = `/s/${testId}`;
	sessionViewState.compact = phone;
	sessionViewState.composerWidth = phone ? 393 : 760;
	instanceState.instances = [
		{
			id: "claude",
			name: "personal",
			driver: "claude",
			isDefault: true,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
		},
	];
	projectState.projects = [
		{ slug: "conduit", title: "conduit", folders: ["/src/conduit"] },
	];
	applySessionChange({
		_tag: "snapshot",
		sequence: Date.now(),
		rows: [
			{
				accountId: "claude",
				id: testId,
				title: "Composer",
				status: "idle",
				projectSlug: "conduit",
				git: { branch: "account-chip", worktree: "account-chip" },
			},
		],
	});
	clearDiscoveryState();
	const contextWindowOptions = [
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M" },
	];
	applyGetModelsResponse(
		{
			projectSlug: "conduit",
			instanceId: "claude",
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
							variants: ["low", "medium", "high", "xhigh", "max"],
							contextWindowOptions,
						},
					],
				},
			],
			active: { model: "claude-sonnet-5", provider: "claude" },
			contextWindow: { contextWindow: "200k", options: contextWindowOptions },
			variant: {
				variant: "high",
				variants: ["low", "medium", "high", "xhigh", "max"],
			},
			permissionMode: "ask",
		},
		testId,
	);
	handleDefaultModelInfo({
		model: "claude-sonnet-5",
		provider: "claude",
		variant: "",
	});
	getOrCreateSessionMessages(testId).contextPercent = 42;
	setComposerPreferences({ controls: "words" });
	return () => {
		setComposerPreferences({ controls: "icons" });
		clearDiscoveryState();
		applySessionChange({
			_tag: "snapshot",
			rows: sessions,
			sequence: Date.now(),
		});
		projectState.projects = projects;
		instanceState.instances = instances;
		instanceState.providerTraits = traits;
		sessionViewState.compact = compact;
		sessionViewState.composerWidth = composerWidth;
		routerState.path = path;
		if (width) Object.defineProperty(window, "innerWidth", width);
		else Reflect.deleteProperty(window, "innerWidth");
		window.dispatchEvent(new Event("resize"));
		if (style != null) canvasElement.setAttribute("style", style);
		else canvasElement.removeAttribute("style");
	};
}

export const WordsDesktop: Story = {
	tags: ["autodocs"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) => setupWords(canvasElement, false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const row = canvas.getByTestId("composer-words-row");
		const phone = sessionViewState.composerTier === "phone";
		async function closePicker() {
			const sheet = canvasElement.ownerDocument.querySelector("dialog[open]");
			if (sheet) sheet.dispatchEvent(new Event("cancel", { cancelable: true }));
			else await userEvent.keyboard("{Escape}");
			await waitFor(() =>
				expect(body.queryByTestId("model-picker")).toBeNull(),
			);
		}
		await expect(row).toBeVisible();
		if (phone) {
			const trigger = await canvas.findByTestId("composer-words-sheet-trigger");
			await expect(trigger).toHaveTextContent("Sonnet 5");
			await expect(trigger).toHaveTextContent("200K");
			await expect(trigger).toHaveTextContent("high");
			await expect(row).toHaveTextContent("42%");
			await expect(row.querySelectorAll("button")).toHaveLength(1);
			await expect(
				row.querySelector("[data-testid='composer-checkout']"),
			).toBeNull();
			await expect(
				within(trigger).getByTestId("composer-word-context-usage"),
			).toHaveTextContent("42%");
			await userEvent.click(
				within(trigger).getByTestId("composer-word-context-usage"),
			);
			const sheet = await body.findByTestId("composer-more-sheet");
			await expect(sheet).toBeVisible();
			await expect(sheet.querySelectorAll('[data-part="label"]')).toHaveLength(
				6,
			);
			await userEvent.keyboard("{Escape}");
			await waitFor(() =>
				expect(body.queryByTestId("composer-more-sheet")).toBeNull(),
			);
			await expect(trigger).toHaveFocus();
			const summary = trigger.querySelector<HTMLElement>(
				'[data-part="summary"]',
			);
			if (!summary) throw new Error("Words summary focus target is missing");
			await expect(getComputedStyle(summary).outlineStyle).toBe("solid");
			await expect(
				Number.parseFloat(getComputedStyle(summary).borderRadius),
			).toBeGreaterThan(0);
			await expect(summary.getBoundingClientRect().width).toBeLessThan(
				trigger.getBoundingClientRect().width,
			);
			return;
		}
		// The row shows "Connecting" until the fake socket opens.
		await expect(
			await canvas.findByTestId("composer-word-model"),
		).toHaveTextContent(phone ? "S5" : "Sonnet 5");
		if (phone)
			await expect(canvas.queryByTestId("composer-word-context")).toBeNull();
		else
			await expect(
				canvas.getByTestId("composer-word-context"),
			).toHaveTextContent("200K");
		await expect(canvas.getByTestId("composer-checkout")).toHaveAttribute(
			"title",
			"conduit / account-chip",
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
		// The phone sheet's <dialog> renders closed and calls showModal() from an
		// effect, so its rows turn visible a tick after they mount.
		await waitFor(() =>
			expect(body.getByTestId("picker-row-effort")).toBeVisible(),
		);
		await userEvent.click(body.getByTestId("picker-effort-option-xhigh"));
		await expect(canvas.getByTestId("composer-word-effort")).toHaveTextContent(
			"xhigh",
		);
		await expect(body.queryByTestId("variant-dropdown")).toBeNull();
		await closePicker();
		await userEvent.click(canvas.getByTestId("composer-word-model"));
		await expect(await body.findByTestId("model-picker")).toBeVisible();
		await expect(body.getByTestId("model-picker-list")).toHaveTextContent(
			"Sonnet 5",
		);
		// The phone sheet is a native <dialog>: a real Escape fires its cancel
		// event, but a synthetic keypress never reaches the browser's handler.
		await closePicker();
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
	beforeEach: ({ canvasElement }) => setupWords(canvasElement, true),
};

export const WordsPhoneLight: Story = {
	...WordsPhone,
	tags: ["autodocs"],
	globals: { theme: "light" },
};

export const ComposerSheet: Story = {
	tags: ["viewport-capture"],
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) => {
		const cleanup = setupWords(canvasElement, true);
		setComposerPreferences({ controls: "icons" });
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		// The previous sheet story's body lock clears asynchronously after it unmounts.
		await waitFor(() =>
			expect(
				getComputedStyle(canvasElement.ownerDocument.body).pointerEvents,
			).not.toBe("none"),
		);
		await userEvent.click(await body.findByTestId("model-picker-trigger"));
		const sheet = await body.findByTestId("composer-more-sheet");
		await waitFor(() => expect(sheet).toBeVisible());
		await expect(body.getByRole("dialog", { name: "Composer" })).toBeVisible();
	},
};
export const ComposerSheetLight: Story = {
	...ComposerSheet,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

// Seed a working session without adding status chrome inside the composer.
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

export const WordsWorkingDesktop: Story = {
	...WordsDesktop,
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "working", false, "words"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("composer-layout")).toHaveAttribute(
			"data-rows",
			"1",
		);
		await expect(canvas.getByTestId("composer-words-row")).toBeVisible();
		await expect(canvas.getByTestId("pending-input-state")).toHaveTextContent(
			"Queued",
		);
		await expect(canvas.getByTestId("pending-input-steer")).toHaveTextContent(
			"Steer",
		);
		await expect(canvas.getByTestId("pending-input-run-now")).toHaveTextContent(
			"Run now",
		);
		await expect(
			canvas.getByTestId("composer-next-turn-note"),
		).toHaveTextContent("next turn");
	},
};
export const WordsWorkingDesktopLight: Story = {
	...WordsWorkingDesktop,
	globals: { theme: "light" },
};
export const WordsWorkingPhone: Story = {
	...WordsPhone,
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "working", true, "words"),
};
export const WordsWorkingPhoneLight: Story = {
	...WordsWorkingPhone,
	globals: { theme: "light" },
};

export const Processing: Story = {
	beforeEach: () => {
		const cleanup = startTurn();
		// Ensure discovery state persists through processing state change
		setHighVariant();
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.queryByTestId("composer-status-header"),
		).not.toBeInTheDocument();
		await expect(canvasElement.querySelector("#stop")).toBeVisible();
	},
};

export const ProcessingLight: Story = {
	...Processing,
	globals: { theme: "light" },
};

let goalStorySetAt = new Date(2026, 9, 17, 10, 24).getTime();

function setupGoal(
	state: "checking" | "not_yet" | "not_yet_idle" | "paused" | "met" | "cleared",
) {
	const previous = sessionGoals.get(testId);
	const pick = getSessionPick(testId);
	const previousModels = {
		projectSlug: "conduit",
		instanceId: pick?.instanceId ?? "opencode",
		providers: discoveryState.providers,
		active: { model: pick?.modelId ?? "", provider: pick?.providerId ?? "" },
		variant: { variant: pick?.variant ?? "", variants: pick?.variants ?? [] },
		contextWindow: {
			contextWindow: pick?.contextWindow ?? "",
			options: pick?.contextWindowOptions ?? [],
		},
		permissionMode: discoveryState.permissionMode,
	};
	applyGetModelsResponse(
		{
			...previousModels,
			instanceId: "claude",
			providers: [
				{
					id: "claude",
					name: "Anthropic",
					configured: true,
					models: [
						{
							id: previousModels.active.model,
							name: "Claude Sonnet 4",
							provider: "claude",
							variants: previousModels.variant.variants,
							contextWindowOptions: previousModels.contextWindow.options,
						},
					],
				},
			],
			active: { ...previousModels.active, provider: "claude" },
		},
		testId,
	);
	// Goals are a Claude feature.
	seedSessionAccount(mockClaudeAccount);
	goalStorySetAt += 1;
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
						state === "met" ? activeGoal.setAt + 38 * 60_000 : Date.now(),
					endedGoal: {
						...activeGoal,
						iterations: 7,
						turnCount: 4,
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
		applyGetModelsResponse(previousModels, testId);
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
			canvas.getByTestId("composer-checking-goal"),
		).toHaveTextContent("Checking goal");
		await expect(
			canvas.queryByTestId("composer-status-elapsed"),
		).not.toBeInTheDocument();
		// The line above names the check; the box keeps its goal outline.
		await expect(canvasElement.querySelector("#input-row")).toHaveAttribute(
			"data-goal",
			"solid",
		);
	},
};

export const GoalNotYetWorking: Story = {
	beforeEach: () => setupGoal("not_yet"),
	play: async ({ canvasElement }) => {
		// The reason lives in the goal details; the composer stays one line.
		await expect(
			within(canvasElement).queryByText("35 of 38 scenarios pass"),
		).not.toBeInTheDocument();
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
		const style = getComputedStyle(row);
		const goalColour = new Option().style;
		goalColour.color = style.getPropertyValue("--color-status-goal");
		await expect(style.outlineStyle).toBe("dashed");
		await expect(style.outlineColor).toBe(goalColour.color);
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
		await expect(bar).toHaveTextContent("Goal met");
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

function narrowComposer(
	width: number,
	mode: "reply" | "goal" | "limited" = "reply",
): Story {
	return {
		tags: ["autodocs"],
		globals: { theme: "dark" },
		beforeEach: ({ canvasElement }) => {
			const cleanup = setupWords(canvasElement, false);
			setComposerPreferences({ controls: "icons" });
			const readings = usageState.readings;
			const limits = usageState.limits;
			const realNow = Date.now;
			const chat = getOrCreateSessionMessages(testId);
			const previousMessages = chat.messages;
			chat.messages = [
				{
					type: "user",
					uuid: "narrow-composer-prompt",
					text: "Verify send visibility",
					turnTiming: { startedAt: Date.now(), waits: [] },
				},
			];
			const session = sessionState.sessions.get(testId);
			if (!session) throw new Error("Composer story session is missing");
			applySessionChange({
				_tag: "upsert",
				sequence: Date.now() + 1,
				item: {
					...session,
					git: {
						branch: "feature/session-account-chip-redesign",
						worktree: "account-chip",
						dirty: true,
					},
				},
			});
			if (mode === "limited") {
				Date.now = () => new Date("2026-10-17T13:00:00+11:00").getTime();
				instanceState.instances = [
					...instanceState.instances.map((account) => ({
						...account,
						usageEligible: true,
					})),
					{
						...mockClaudeAccount,
						id: "work",
						name: "work",
						isDefault: false,
						usageEligible: true,
					},
				];
				usageState.limits = { ...limits, autoSwitch: false };
				usageState.readings = [
					{
						accountId: "claude",
						harness: "claude",
						status: "limited",
						windows: [
							{
								kind: "five_hour",
								utilization: 100,
								resetsAt: new Date("2026-10-17T15:40:00+11:00").toISOString(),
							},
						],
						readAt: Date.now(),
						stale: false,
					},
				];
			}
			return () => {
				Date.now = realNow;
				chat.messages = previousMessages;
				usageState.readings = readings;
				usageState.limits = limits;
				phaseToIdle(getOrCreateSessionActivity(testId));
				cleanup();
			};
		},
		play: async ({ canvasElement, step }) => {
			const canvas = within(canvasElement);
			const composer = canvasElement.querySelector<HTMLElement>("#input-row");
			const wrapper =
				canvasElement.querySelector<HTMLElement>("#input-wrapper");
			if (!composer || !wrapper) throw new Error("Composer is missing");
			wrapper.style.width = `${width}px`;
			const textarea = canvas.getByRole<HTMLTextAreaElement>("textbox", {
				name: "Message",
			});
			const draft =
				mode === "goal"
					? "$goal Verify send visibility"
					: "Verify send visibility";
			await userEvent.type(textarea, draft);
			const send = canvasElement.querySelector<HTMLButtonElement>("#send");
			if (!send) throw new Error("Send is missing");
			const sendControl =
				canvasElement.querySelector<HTMLElement>(
					'[data-testid="composer-send-control"]',
				) ?? send;
			await step(
				`${width}px ${mode}: the whole send control fits and can be hit`,
				async () => {
					await waitFor(() => {
						const bounds = composer.getBoundingClientRect();
						const button = send.getBoundingClientRect();
						const control = sendControl.getBoundingClientRect();
						expect(Math.abs(bounds.width - width)).toBeLessThanOrEqual(0.5);
						expect(send.disabled).toBe(false);
						let left = Math.max(0, bounds.left),
							top = Math.max(0, bounds.top);
						let right = Math.min(
								document.documentElement.clientWidth,
								bounds.right,
							),
							bottom = Math.min(
								document.documentElement.clientHeight,
								bounds.bottom,
							);
						for (
							let ancestor = sendControl.parentElement;
							ancestor;
							ancestor = ancestor.parentElement
						) {
							const css = getComputedStyle(ancestor),
								rect = ancestor.getBoundingClientRect();
							if (/hidden|clip|scroll|auto/.test(css.overflowX)) {
								left = Math.max(left, rect.left);
								right = Math.min(right, rect.right);
							}
							if (/hidden|clip|scroll|auto/.test(css.overflowY)) {
								top = Math.max(top, rect.top);
								bottom = Math.min(bottom, rect.bottom);
							}
						}
						expect(control.left).toBeGreaterThanOrEqual(left - 0.5);
						expect(control.right).toBeLessThanOrEqual(right + 0.5);
						expect(control.top).toBeGreaterThanOrEqual(top - 0.5);
						expect(control.bottom).toBeLessThanOrEqual(bottom + 0.5);
						for (const [x, y] of [
							[button.left + 2, button.top + button.height / 2],
							[button.right - 2, button.top + button.height / 2],
							[button.left + button.width / 2, button.top + button.height / 2],
						]) {
							const target = document.elementFromPoint(x ?? 0, y ?? 0);
							expect(target && send.contains(target)).toBe(true);
						}
					});
				},
			);
			await step(
				`${width}px ${mode}: clicking send submits the draft`,
				async () => {
					await userEvent.click(send);
					await waitFor(() => expect(textarea).toHaveValue(""));
					if (mode !== "limited") {
						await waitFor(() => expect(readTurn(testId).working).toBe(true));
					}
					composer.dataset["sendVisibilityProof"] = JSON.stringify({
						width,
						mode,
						fullyVisible: true,
						clickClearedDraft: true,
					});
				},
			);
			phaseToIdle(getOrCreateSessionActivity(testId));
			await userEvent.type(textarea, draft);
		},
	};
}

export const Narrow296: Story = narrowComposer(296);
export const Narrow366: Story = narrowComposer(366);
export const Narrow395: Story = narrowComposer(395);
export const Narrow296Light: Story = {
	...Narrow296,
	globals: { theme: "light" },
};
export const Narrow366Light: Story = {
	...Narrow366,
	globals: { theme: "light" },
};
export const Narrow395Light: Story = {
	...Narrow395,
	globals: { theme: "light" },
};
export const NarrowGoal296: Story = narrowComposer(296, "goal");
export const NarrowGoal366: Story = narrowComposer(366, "goal");
export const NarrowGoal395: Story = narrowComposer(395, "goal");
export const NarrowGoal296Light: Story = {
	...NarrowGoal296,
	globals: { theme: "light" },
};
export const NarrowGoal366Light: Story = {
	...NarrowGoal366,
	globals: { theme: "light" },
};
export const NarrowGoal395Light: Story = {
	...NarrowGoal395,
	globals: { theme: "light" },
};
export const NarrowLimited296: Story = narrowComposer(296, "limited");
export const NarrowLimited366: Story = narrowComposer(366, "limited");
export const NarrowLimited395: Story = narrowComposer(395, "limited");
export const NarrowLimited296Light: Story = {
	...NarrowLimited296,
	globals: { theme: "light" },
};
export const NarrowLimited366Light: Story = {
	...NarrowLimited366,
	globals: { theme: "light" },
};
export const NarrowLimited395Light: Story = {
	...NarrowLimited395,
	globals: { theme: "light" },
};

export const FinalIconsDesktop: Story = {
	beforeEach: ({ canvasElement }) => {
		const cleanup = setupWords(canvasElement, false);
		setComposerPreferences({ controls: "icons" });
		return cleanup;
	},
};
export const FinalIconsDesktopLight: Story = {
	...FinalIconsDesktop,
	globals: { theme: "light" },
};
export const FinalIconsPhone: Story = {
	...FinalIconsDesktop,
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) => {
		const cleanup = setupWords(canvasElement, true);
		setComposerPreferences({ controls: "icons" });
		return cleanup;
	},
};
export const FinalIconsPhoneLight: Story = {
	...FinalIconsPhone,
	globals: { theme: "light" },
};

function setupDollarMenu(canvasElement: HTMLElement, phone = false) {
	const cleanup = setupWords(canvasElement, phone);
	setComposerPreferences({ controls: "icons" });
	getOrCreateSessionMessages(testId).contextPercent = 86;
	handleCommandList({
		commands: [
			{
				name: "compact",
				description: "Summarize to free context",
				builtin: true,
			},
			{ name: "clear", description: "Clear the conversation", builtin: true },
			{
				name: "cost",
				description: "Token use and cost for this session",
				builtin: true,
			},
			{ name: "help", description: "Show help", builtin: true },
			{ name: "init", description: "Initialize the project", builtin: true },
			{ name: "memory", description: "Manage memory", builtin: true },
			{ name: "model", description: "Choose a model", builtin: true },
			{ name: "review", description: "Review a pull request" },
		],
	});
	return cleanup;
}

export const DollarMenu: Story = {
	...FinalIconsDesktop,
	tags: ["viewport-capture"],
	beforeEach: ({ canvasElement }) => setupDollarMenu(canvasElement),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByRole("textbox", { name: "Message" }), "$");
		const menu = await canvas.findByRole("listbox", {
			name: "Built-in commands",
		});
		await expect(within(menu).getAllByRole("option")[0]).toHaveTextContent(
			"$goal",
		);
		await expect(
			within(menu).getByTestId("command-context-percent"),
		).toHaveTextContent("86%");
		await expect(within(menu).queryByText("$review")).toBeNull();
		const composer = canvasElement.querySelector("#input-row");
		if (!composer) throw new Error("Composer is missing");
		await waitFor(() => {
			const menuRect = menu.getBoundingClientRect();
			const composerRect = composer.getBoundingClientRect();
			expect(Math.abs(menuRect.left - composerRect.left)).toBeLessThanOrEqual(
				1,
			);
			expect(Math.abs(menuRect.width - composerRect.width)).toBeLessThanOrEqual(
				1,
			);
		});
	},
};
export const DollarMenuLight: Story = {
	...DollarMenu,
	globals: { theme: "light" },
};

export const DollarMenuPhone: Story = {
	...DollarMenu,
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) => setupDollarMenu(canvasElement, true),
};
export const DollarMenuPhoneLight: Story = {
	...DollarMenuPhone,
	globals: { theme: "light" },
};

export const AttachMenuOpen: Story = {
	...FinalIconsDesktop,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "Attach",
			}),
		);
		const menu = await within(document.body).findByTestId("attach-menu");
		await expect(within(menu).getByText("Take Photo")).toBeVisible();
		await expect(within(menu).getByText("Add Photos")).toBeVisible();
		await expect(within(menu).getByText("Add Files")).toBeVisible();
		await expect(within(menu).getByText("Same as $goal")).toBeVisible();
	},
};
export const AttachMenuOpenLight: Story = {
	...AttachMenuOpen,
	globals: { theme: "light" },
};

export const ModeMenuOpen: Story = {
	...FinalIconsDesktop,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			await within(canvasElement).findByTestId("permission-mode-badge"),
		);
		const menu = await within(document.body).findByTestId(
			"permission-mode-dropdown",
		);
		await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(6);
		await expect(
			within(menu).getByText("Ask before edits", { exact: true }),
		).toBeVisible();
		await expect(
			within(menu).getByText("Auto-accept edits", { exact: true }),
		).toBeVisible();
	},
};
export const ModeMenuOpenLight: Story = {
	...ModeMenuOpen,
	globals: { theme: "light" },
};

function setupComposerStage(
	canvasElement: HTMLElement,
	stage: "usage" | "limited" | "waiting" | "working" | "paused" | "context",
	phone = false,
	controls: "icons" | "words" = "icons",
) {
	const chat = getOrCreateSessionMessages(testId);
	const previousMessages = chat.messages;
	const previousTranscript = chat.transcript;
	const previousContext = chat.contextPercent;
	const preferences = { ...composerPreferences };
	const readings = usageState.readings;
	const limits = usageState.limits;
	const realNow = Date.now;
	const dismissalKeys = [
		`conduit-usage-warning-dismissal:${testId}`,
		`conduit:context-warning-dismissed:${testId}`,
	].map((key) => [key, localStorage.getItem(key)] as const);
	for (const [key] of dismissalKeys) localStorage.removeItem(key);
	const cleanup = setupWords(canvasElement, phone);
	setComposerPreferences({ controls, contextWarning: 80 });
	const now = new Date(2026, 9, 17, 13).getTime();
	const reset = new Date(2026, 9, 17, 15, 40).getTime();
	Date.now = () => now;
	const limited = stage === "limited" || stage === "waiting";
	instanceState.instances = [
		...instanceState.instances.map((account) => ({
			...account,
			name: limited ? "lab" : stage === "usage" ? "work" : "personal",
			usageEligible: true,
		})),
		{
			...mockClaudeAccount,
			id: "standby",
			name: "personal",
			isDefault: false,
			usageEligible: true,
		},
		...(stage === "usage"
			? [
					{
						...mockClaudeAccount,
						id: "lab",
						name: "lab",
						isDefault: false,
						usageEligible: true,
					},
				]
			: []),
	];
	usageState.limits = {
		...limits,
		autoSwitch: false,
		autoResume: false,
		warnAt: 80,
	};
	usageState.readings = [
		{
			accountId: "claude",
			harness: "claude",
			status: limited ? "limited" : "available",
			windows: [
				{
					kind: "five_hour",
					utilization: limited ? 100 : stage === "usage" ? 91 : 42,
					resetsAt: new Date(
						limited ? reset : reset + 30 * 60_000,
					).toISOString(),
				},
			],
			readAt: now,
			stale: false,
		},
		{
			accountId: "standby",
			harness: "claude",
			status: "available",
			windows: [{ kind: "five_hour", utilization: 42 }],
			readAt: now,
			stale: false,
		},
		...(stage === "usage"
			? [
					{
						accountId: "lab",
						harness: "claude" as const,
						status: "limited" as const,
						windows: [],
						readAt: now,
						stale: false,
					},
				]
			: []),
	];
	const session = sessionState.sessions.get(testId);
	if (!session) throw new Error("Composer stage session is missing");
	applySessionChange({
		_tag: "upsert",
		// Past the seeded session's real-clock sequence, or the store keeps the older row.
		sequence: realNow() + 1,
		item: {
			...session,
			git: {
				branch: "feat/typed-session-list",
				worktree: "composer",
				dirty: true,
			},
			...(limited
				? {
						limitRecovery: {
							instanceId: "claude",
							rateLimitType: "five_hour",
							resetsAt: reset / 1000,
							cutOffMessageId: "composer-limit-turn",
							rearms: 0,
							continued: false,
							...(stage === "waiting"
								? { scheduledAt: reset / 1000, auto: true }
								: {}),
						},
					}
				: {}),
		},
	});
	chat.contextPercent = stage === "context" ? 86 : 42;
	chat.transcript = {
		rows: [],
		hwm: 1,
		hasMore: false,
		status: { _tag: "live" },
		project: "conduit",
		pending:
			stage === "waiting" || stage === "working" || stage === "paused"
				? [
						{
							inputId: "composer-queued-message",
							state: "queued",
							request: {
								text:
									stage === "waiting"
										? "Rerun the webkit suite and fix what's left"
										: "Also run it on chromium",
							},
							admittedAt: now - 2 * 60_000,
						},
					]
				: [],
		paused: stage === "paused",
		steer: stage === "working" ? null : "no_steering",
		waiting: new Map<string, never[]>(),
		partOrder: new Map<string, number>(),
	};
	const endTurn = stage === "working" ? startTurn() : undefined;
	return () => {
		endTurn?.();
		phaseToIdle(getOrCreateSessionActivity(testId));
		chat.messages = previousMessages;
		chat.transcript = previousTranscript;
		chat.contextPercent = previousContext;
		Date.now = realNow;
		usageState.readings = readings;
		usageState.limits = limits;
		cleanup();
		setComposerPreferences(preferences);
		for (const [key, value] of dismissalKeys) {
			if (value === null) localStorage.removeItem(key);
			else localStorage.setItem(key, value);
		}
	};
}

export const UsageWarningDesktop: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) => setupComposerStage(canvasElement, "usage"),
	play: async ({ canvasElement }) => {
		const strip = within(canvasElement).getByTestId("usage-warning-strip");
		await expect(strip).toHaveTextContent(
			"work, has used 91% of its 5-hour window.",
		);
		await expect(
			within(strip).getByTestId("usage-warning-switch-account"),
		).toBeVisible();
		await expect(
			within(strip).getByTestId("usage-warning-detail"),
		).toHaveTextContent("Resets at 4:10 pm");
	},
};
export const UsageWarningDesktopLight: Story = {
	...UsageWarningDesktop,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const UsageWarningPhone: Story = {
	...UsageWarningDesktop,
	tags: ["viewport-capture"],
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "usage", true),
	play: async ({ canvasElement }) => {
		const strip = within(canvasElement).getByTestId("usage-warning-strip");
		await expect(strip).toHaveTextContent(
			"work, has used 91% of its 5-hour window.",
		);
		await expect(
			within(strip).getByRole("button", { name: "Dismiss usage warning" }),
		).toHaveTextContent("Dismiss");
		await expect(
			within(strip).getByTestId("usage-warning-switch-account"),
		).toHaveTextContent("Switch to personal");
	},
};
export const UsageWarningPhoneLight: Story = {
	...UsageWarningPhone,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const Limited: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "limited"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("usage-limit-strip")).toHaveTextContent(
			"lab hit its 5-hour limit.",
		);
		await expect(canvas.getByTestId("usage-limit-detail")).toHaveTextContent(
			"Resets at 3:40 pm.",
		);
		await userEvent.type(
			canvas.getByRole("textbox", { name: "Message" }),
			"Rerun the webkit suite and fix what's left",
		);
		await expect(canvas.getByTestId("composer-send-control")).toBeVisible();
		await expect(
			canvas.getByTestId("composer-send-menu-trigger"),
		).toBeVisible();
		await expect(canvasElement.querySelector("#send")).toHaveAttribute(
			"data-send-mode",
			"at-reset",
		);
	},
};
export const LimitedLight: Story = {
	...Limited,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const WaitingForReset: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "waiting"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("pending-input-waiting")).toHaveTextContent(
			"Waiting for lab's limit to reset",
		);
		await expect(
			canvas.getByTestId("pending-input-sends-at"),
		).toHaveTextContent("sends");
		await expect(canvas.getByTestId("pending-input-send-now")).toBeVisible();
		await expect(canvas.queryByTestId("usage-limit-strip")).toBeNull();
		const cancel = canvas.getByTestId("usage-limit-cancel-resume");
		const actions = cancel.parentElement;
		if (!actions) throw new Error("Waiting tray actions are missing");
		await expect(getComputedStyle(cancel).flexGrow).toBe("0");
		const header = canvas.getByTestId("pending-input-waiting");
		const headerRect = header.getBoundingClientRect();
		await expect(cancel.getBoundingClientRect().width).toBeLessThan(
			headerRect.width * 0.7,
		);
		await expect(
			Math.abs(
				actions.getBoundingClientRect().right -
					headerRect.right +
					Number.parseFloat(getComputedStyle(header).paddingRight),
			),
		).toBeLessThanOrEqual(1);
	},
};
export const WaitingForResetLight: Story = {
	...WaitingForReset,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const WaitingForResetPhone: Story = {
	...WaitingForReset,
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "waiting", true),
};
export const WaitingForResetPhoneLight: Story = {
	...WaitingForResetPhone,
	globals: { theme: "light" },
};

export const WorkingQueued: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "working"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("pending-input-state")).toHaveTextContent(
			"Queued",
		);
		await expect(canvas.getByTestId("pending-input-text")).toHaveTextContent(
			"Also run it on chromium",
		);
		await expect(canvas.getByTestId("pending-input-steer")).toHaveTextContent(
			"Steer",
		);
		await expect(canvas.getByTestId("pending-input-run-now")).toHaveTextContent(
			"Run now",
		);
		await expect(canvas.getByTestId("composer-next-turn-note")).toBeVisible();
		await expect(
			canvas.getByRole("button", { name: "Stop generating" }),
		).toBeVisible();
	},
};
export const WorkingQueuedLight: Story = {
	...WorkingQueued,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const PausedQueued: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "paused"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("pending-input-paused")).toHaveTextContent(
			"Paused · you stopped the turn",
		);
		await expect(canvas.getByTestId("pending-input-resume")).toBeVisible();
		await expect(canvas.getByTestId("pending-input-run-now")).toBeVisible();
		await expect(canvas.getByTestId("pending-input-edit")).toBeVisible();
		await expect(canvas.getByTestId("pending-input-remove")).toBeVisible();
	},
};
export const PausedQueuedLight: Story = {
	...PausedQueued,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const ContextWarning: Story = {
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "context"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("composer-context-warning"),
		).toHaveTextContent(
			"Context 86% full. Compact soon to keep replies sharp.",
		);
		await expect(canvas.getByTestId("composer-context-compact")).toBeVisible();
	},
};
export const ContextWarningLight: Story = {
	...ContextWarning,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const LimitedPhone: Story = {
	...Limited,
	tags: ["viewport-capture"],
	parameters: { phone: true },
	beforeEach: ({ canvasElement }) =>
		setupComposerStage(canvasElement, "limited", true),
};
export const LimitedPhoneLight: Story = {
	...LimitedPhone,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

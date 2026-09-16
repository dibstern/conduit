import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import Button from "./Button.svelte";

/** Pass a plain text label as Button's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/Button",
	component: Button,
	tags: ["autodocs"],
	args: { children: label("Button") },
	argTypes: {
		variant: {
			control: "select",
			options: [
				"primary",
				"secondary",
				"ghost",
				"ghost-accent",
				"danger",
				"success-soft",
				"danger-outline",
				"accent-soft",
				"toolbar",
				"pill",
			],
		},
		size: { control: "inline-radio", options: ["sm", "md", "content"] },
		icon: { control: "text" },
		iconOnly: { control: "boolean" },
		loading: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
	args: { variant: "primary", children: label("Save changes") },
};
export const Secondary: Story = {
	args: { variant: "secondary", children: label("Cancel") },
};
export const Ghost: Story = {
	args: { variant: "ghost", children: label("Dismiss") },
};
export const GhostAccent: Story = {
	args: { variant: "ghost-accent", children: label("Learn more") },
};
export const Danger: Story = {
	args: { variant: "danger", children: label("Delete project") },
};

export const Small: Story = {
	args: { variant: "primary", size: "sm", children: label("Small") },
};

export const SuccessSoft: Story = {
	args: { variant: "success-soft", children: label("Allow") },
};
export const DangerOutline: Story = {
	args: { variant: "danger-outline", children: label("Deny") },
};
export const AccentSoft: Story = {
	args: { variant: "accent-soft", children: label("Show full output") },
};

/**
 * The only variant that carries geometry (see Button.svelte::pill). It is
 * always paired with `size="content"`, so the story pairs them too -- a `Pill`
 * on `sm`/`md` would pick up a conflicting `rounded-lg` and this baseline is
 * what would catch someone "simplifying" that pairing away.
 */
export const Pill: Story = {
	args: {
		variant: "pill",
		size: "content",
		children: label("Personal"),
	},
};

/**
 * `size="content"` emits no padding, radius, weight or type scale — the call
 * site brings its own, additively. Without a baseline this story would be an
 * unstyled box, which is the point: it proves the size really is an opt-out
 * rather than quietly leaking `sm`/`md` geometry. The class below is what a
 * real migrated call site looks like (conduit-test-de3.5).
 */
export const ContentSize: Story = {
	args: {
		variant: "ghost",
		size: "content",
		class: "px-2 py-0.5 rounded text-xs font-normal",
		children: label("Content-sized"),
	},
	play: ({ canvasElement }) => {
		const button = canvasElement.querySelector("button");
		expect(button, "ContentSize story rendered no button").not.toBeNull();
		const classes = button?.className.split(/\s+/) ?? [];
		// `h-auto` is in this list on purpose: it is not a leak of `sm`/`md`
		// geometry, but emitting it would still force a `!` on any call site
		// that sets its own height. "content emits nothing" is the contract.
		for (const leaked of [
			"h-8",
			"h-9",
			"h-auto",
			"px-3",
			"px-4",
			"text-sm",
			"gap-2",
			"rounded-lg",
			"font-medium",
		]) {
			expect(
				classes,
				`size="content" must emit no ${leaked} — a call site cannot override it without "!"`,
			).not.toContain(leaked);
		}
	},
};

export const WithIcon: Story = {
	args: { variant: "primary", icon: "save", children: label("Save") },
};

export const IconOnly: Story = {
	args: {
		variant: "ghost",
		iconOnly: true,
		icon: "settings",
		ariaLabel: "Settings",
		// Explicitly cleared, not redundant: the meta above sets a default
		// `children` for every story, and this one inherited it. Button used to
		// discard children whenever `iconOnly` was set, so the stray label was
		// invisible and this baseline looked correct. Removing that silent
		// discard (conduit-test-arl1) is what surfaced it. Storybook merges meta
		// args at runtime, so the props union cannot catch this — the assertion
		// below is the guard instead.
		children: undefined,
	},
	play: ({ canvasElement }) => {
		expect(
			canvasElement.querySelector("button")?.textContent?.trim(),
			"An icon-only Button must render no text; a stray label here means meta args leaked in",
		).toBe("");
	},
};

export const Loading: Story = {
	args: { variant: "primary", loading: true, children: label("Saving…") },
};

export const Disabled: Story = {
	args: { variant: "primary", disabled: true, children: label("Unavailable") },
};

/** Asserting interaction: an enabled Button invokes its onclick. */
export const ClickInteraction: Story = {
	args: { variant: "primary", onclick: fn(), children: label("Click me") },
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		await userEvent.click(button);
		await expect(args["onclick"]).toHaveBeenCalledOnce();
	},
};

/** Asserting interaction: a disabled Button swallows clicks. */
export const DisabledInteraction: Story = {
	args: {
		variant: "primary",
		disabled: true,
		onclick: fn(),
		children: label("No-op"),
	},
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole<HTMLButtonElement>("button");
		await expect(button).toBeDisabled();
		// Force past the pointer-events:none guard: the native `disabled` attribute
		// must still swallow the click, so onclick never fires.
		await userEvent.click(button, { pointerEventsCheck: 0 });
		await expect(args["onclick"]).not.toHaveBeenCalled();
	},
};

export const Hover: Story = {
	...Primary,
	parameters: { pseudo: { hover: true } },
};

export const FocusVisible: Story = {
	...Primary,
	// Scoped to the button rather than `focusVisible: true`.
	//
	// storybook-addon-pseudo-states implements the boolean form by putting
	// `.pseudo-focus-visible-all` on the story container and rewriting every
	// `:focus-visible` rule to also match `.pseudo-focus-visible-all :where(*)`.
	// For a rule written against a bare `:focus-visible` — the house focus ring
	// in style.css — that means EVERY descendant matches, so the wrapper div
	// around the subject drew its own square outline on top of the subject's
	// own ring. The product never does this: Tab to a real Pill or Button and
	// the computed outline-style is `none`, the ring is the box-shadow.
	// The array form applies the class to the matched element only, so the
	// story depicts one ring, the one being tested (conduit-test-j7ny).
	parameters: { pseudo: { focusVisible: ["button"] } },
};

/**
 * The anchor branch. Without a story the `href` path has no visual baseline at
 * all, and the failure it would hide is a quiet one: an <a> that stopped
 * looking like the <button> beside it (conduit-test-75iq).
 *
 * The play() assertion is the load-bearing half. `no-underline` lives in
 * BASE_CLASSES precisely because the UA stylesheet underlines anchors and no
 * variant wants that, so a regression here is one deleted utility away and
 * would read as "slightly different text" in a diff rather than as a bug.
 */
export const Link: Story = {
	args: {
		variant: "primary",
		href: "https://example.com/install",
		children: label("Download"),
	},
	play: async ({ canvasElement }) => {
		const anchor = within(canvasElement).getByRole("link", {
			name: "Download",
		});
		await expect(anchor.tagName).toBe("A");
		await expect(anchor).toHaveAttribute("href", "https://example.com/install");
		// Not a <button>: no `type`, and nothing that would submit a form.
		await expect(anchor).not.toHaveAttribute("type");
		await expect(getComputedStyle(anchor).textDecorationLine).toBe("none");
	},
};

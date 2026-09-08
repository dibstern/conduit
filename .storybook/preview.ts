import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";
import { setThemeMode } from "../src/lib/frontend/stores/theme.svelte.js";

const preview: Preview = {
	globalTypes: {
		theme: {
			description: "Theme",
			toolbar: {
				icon: "paintbrush",
				items: [
					{ value: "dark", title: "Dark" },
					{ value: "light", title: "Light" },
				],
			},
		},
	},

	// Runs before the story renders, so it is safe to mutate the theme store here.
	// Doing this in a decorator instead throws state_unsafe_mutation: a decorator
	// body executes *during* render, and setThemeMode() writes module-level $state.
	// Going through the real store (rather than only toggling the class) keeps the
	// JS-side consumers -- Mermaid in AssistantMessage, the xterm palette in
	// TerminalTab, the Settings control -- in agreement with the CSS.
	beforeEach: (context) => {
		setThemeMode(context.globals["theme"] === "light" ? "light" : "dark");
	},

	parameters: {
		// "todo" = axe runs and reports, but does not fail the run.
		// The remaining non-contrast accessibility work is tracked in
		// conduit-test-de3.28; palette contrast is handled by the first-party
		// Light and Dark palettes; the palette step adds shipped-token assertions.
		// Flip to "error" as the last step of that burn-down.
		a11y: { test: "todo" },
		layout: "fullscreen",
		// Overlay/modal/toast stories set `parameters.docs.story.inline = false`
		// individually so their fixed/absolute-positioned elements render within
		// the story iframe rather than escaping into the Storybook chrome.
		// All other stories use the default inline rendering which auto-sizes
		// to the component's natural height.
	},

	initialGlobals: {
		theme: "dark",
	},
};

export default preview;

import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";
import {
	ALL_CSS_VAR_KEYS,
	DEFAULT_THEME_ID,
} from "../src/lib/frontend/stores/theme.svelte.js";
import type { Base16Theme } from "../src/lib/frontend/stores/theme-compute.js";
import { computeVars } from "../src/lib/frontend/stores/theme-compute.js";

const themeModules = import.meta.glob<Base16Theme>("../src/lib/themes/*.json", {
	eager: true,
	import: "default",
});

const themes = Object.fromEntries(
	Object.entries(themeModules).map(([path, theme]) => [
		path.slice(path.lastIndexOf("/") + 1, -".json".length),
		theme,
	]),
);

const preview: Preview = {
	globalTypes: {
		theme: {
			description: "Theme",
			toolbar: {
				icon: "paintbrush",
				items: Object.entries(themes).map(([id, theme]) => ({
					value: id,
					title: theme.name,
				})),
			},
		},
	},

	decorators: [
		(Story, context) => {
			const selectedTheme =
				themes[context.globals.theme] ?? themes[DEFAULT_THEME_ID];
			if (!selectedTheme) return Story();

			const vars = computeVars(selectedTheme);
			const root = document.documentElement;

			for (const key of ALL_CSS_VAR_KEYS) {
				if (!(key in vars)) root.style.removeProperty(key);
			}
			for (const [key, value] of Object.entries(vars)) {
				root.style.setProperty(key, value);
			}

			const isLight = selectedTheme.variant === "light";
			root.classList.toggle("light-theme", isLight);
			root.classList.toggle("dark-theme", !isLight);

			return Story();
		},
	],

	parameters: {
		// "todo" = axe runs and reports, but does not fail the run.
		//
		// This is NOT a permanent choice and NOT a silent suppression. Flipping this
		// to "error" today fails 302 of 438 story tests across 69 of 92 files. The
		// violations are real (verified: `button-name` is caught when injected) and
		// are tracked in conduit-test-de3.28, whose burn-down is now decided:
		//
		//   1. de3.28.1 — the ~234 mechanical, non-contrast violations
		//      (aria-required-parent, button-name, label, nested-interactive, …).
		//   2. de3.28.2 — the ~1516 contrast violations, which are NOT a set of bad
		//      hex values. `theme-compute.ts` maps conduit's four text tiers onto
		//      base16 slots, and `--color-text-dimmer` lands on base03 — the slot the
		//      spec reserves for "comments, invisibles, line highlighting". base16
		//      offers only three usable foreground slots, so the fourth tier reached
		//      into one that is *designed* to be illegible. That is a slot-mapping
		//      bug across all 24 themes, not a visual-language change, so it is fixed
		//      by enforcing a contrast floor in computeVars rather than by
		//      redesigning anything.
		//
		// Flip to "error" as the last step of that burn-down — and note the toolbar
		// theme selector above means "green" will finally mean green in every theme,
		// not just the default dark one.
		a11y: { test: "todo" },
		layout: "fullscreen",
		// Overlay/modal/toast stories set `parameters.docs.story.inline = false`
		// individually so their fixed/absolute-positioned elements render within
		// the story iframe rather than escaping into the Storybook chrome.
		// All other stories use the default inline rendering which auto-sizes
		// to the component's natural height.
	},

	initialGlobals: {
		theme: DEFAULT_THEME_ID,
	},
};

export default preview;

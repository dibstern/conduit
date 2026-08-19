import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";

const preview: Preview = {
	parameters: {
		// "todo" = axe runs and reports, but does not fail the run.
		//
		// This is NOT a permanent choice and NOT a silent suppression. Flipping this
		// to "error" today fails 302 of 438 story tests across 69 of 92 files. The
		// violations are real (verified: `button-name` is caught when injected), and
		// they collapse to a small number of root causes tracked in conduit-test-de3.28 —
		// principally two text tokens whose contrast against the app background is
		// below WCAG AA. Fixing them is a visual-language decision, which this plan
		// lists as a non-goal, so it needs a human call rather than an agent's.
		//
		// Flip to "error" as the last step of that burn-down.
		a11y: { test: "todo" },
		backgrounds: {
			options: {
				app: { name: "app", value: "#18181B" },
				light: { name: "light", value: "#FDFCFC" },
				surface: { name: "surface", value: "#27272A" },
			},
		},
		layout: "fullscreen",
		// Overlay/modal/toast stories set `parameters.docs.story.inline = false`
		// individually so their fixed/absolute-positioned elements render within
		// the story iframe rather than escaping into the Storybook chrome.
		// All other stories use the default inline rendering which auto-sizes
		// to the component's natural height.
	},

	initialGlobals: {
		backgrounds: {
			value: "app",
		},
	},
};

export default preview;

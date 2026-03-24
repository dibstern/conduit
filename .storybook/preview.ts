import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";

const preview: Preview = {
	parameters: {
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

import type { Preview } from "@storybook/svelte-vite";
import "../src/lib/frontend/style.css";

const preview: Preview = {
	parameters: {
		backgrounds: {
			options: {
				app: { name: "app", value: "hsl(0, 20%, 99%)" },
				dark: { name: "dark", value: "#2F2E2B" },
				surface: { name: "surface", value: "#262522" },
			},
		},
		layout: "fullscreen",
	},

	initialGlobals: {
		backgrounds: {
			value: "app",
		},
	},
};

export default preview;

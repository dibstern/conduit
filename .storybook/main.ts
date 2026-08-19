import type { StorybookConfig } from "@storybook/svelte-vite";

const config: StorybookConfig = {
	stories: [
		"../src/lib/frontend/**/*.mdx",
		"../src/lib/frontend/**/*.stories.ts",
	],
	addons: [
		"@storybook/addon-a11y",
		"@storybook/addon-docs",
		"storybook-addon-pseudo-states",
		"@storybook/addon-vitest",
	],
	framework: {
		name: "@storybook/svelte-vite",
		options: {},
	},
};

export default config;

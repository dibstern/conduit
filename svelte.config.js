/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
	compilerOptions: {
		// Runes mode is auto-detected per component in Svelte 5.
		// We don't set runes: true globally because Storybook's internal
		// .svelte files still use legacy `export let` syntax.
	},
};

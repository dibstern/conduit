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

		// A story that hits the network renders whatever the host's network stack
		// happened to be doing when the frame was captured, and it fails SILENTLY:
		// components catch their own fetch errors, so the suite stays green while
		// the baseline records a random frame. Pages/SetupPage did exactly this —
		// its darwin golden froze mid-probe and its linux golden froze settled, so
		// the two platforms disagreed about what the story depicted and the
		// zero-tolerance gate passed anyway. See conduit-test-de3.33.
		//
		// So: reject every request (deterministic) AND fail the story afterwards
		// (visible), because rejecting alone would just be caught and swallowed.
		const realFetch = globalThis.fetch;
		const requested: string[] = [];
		globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
			requested.push(input instanceof Request ? input.url : String(input));
			return Promise.reject(new TypeError("Failed to fetch"));
		};

		return () => {
			globalThis.fetch = realFetch;
			if (requested.length === 0) return;
			throw new Error(
				`Story "${context.id}" made ${requested.length} unstubbed network ` +
					`request(s): ${requested.join(", ")}. Stories must not reach the ` +
					`network — the render races the request and the visual baseline ` +
					`captures whichever frame won, differently on each platform. Stub ` +
					`globalThis.fetch in the story's (or meta's) beforeEach and assert ` +
					`the settled state in play(). See conduit-test-de3.33.\n\nNOTE: ` +
					`Storybook runs a story's beforeEach cleanup during the NEXT ` +
					`story's test, so this failure is reported against a different ` +
					`test than the one at fault. Trust the story id above, not the ` +
					`test name the runner prints.`,
			);
		};
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

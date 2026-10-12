import type { HLJSApi } from "highlight.js";

let highlighter: Promise<HLJSApi> | undefined;

export function loadHighlighter(): Promise<HLJSApi> {
	return (highlighter ??= import("highlight.js").then(({ default: hljs }) => {
		hljs.registerAliases(["svelte", "vue"], { languageName: "xml" });
		return hljs;
	}));
}

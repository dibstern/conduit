import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./stores/theme.svelte.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

// Reconcile the mode applied by index.html before mounting reactive consumers.
initTheme();

// Installed iOS PWA: rotating back to portrait briefly lays out at full screen
// height, then shrinks by the status bar and scrolls the root by the
// difference. `overflow: hidden` doesn't prevent it and WebKit never clamps it,
// so the app stays shifted up. Pull any scroll past the document's end back.
// The keyboard's scroll stays within range (taller document than viewport).
const clampRootScroll = () => {
	const max = Math.max(
		0,
		document.documentElement.scrollHeight - window.innerHeight,
	);
	if (window.scrollY > max + 1) window.scrollTo(0, max);
};
window.addEventListener("resize", clampRootScroll);
window.addEventListener("scroll", clampRootScroll);

mount(App, { target });

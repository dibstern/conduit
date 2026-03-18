import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./stores/theme.svelte.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

// Initialize theme before mount to avoid flash of unstyled content.
// The inline script in index.html applies cached vars instantly; this
// loads the full theme list from the server and reconciles state.
await initTheme();

mount(App, { target });

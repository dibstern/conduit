import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./stores/theme.svelte.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

// Reconcile the mode applied by index.html before mounting reactive consumers.
initTheme();

mount(App, { target });

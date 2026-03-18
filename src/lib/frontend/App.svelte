<!-- ─── App Root ────────────────────────────────────────────────────────────── -->
<!-- Root component with client-side routing. Renders the appropriate page -->
<!-- based on the current URL path. -->

<script lang="ts">
	import { getCurrentRoute } from "./stores/router.svelte.js";
	import ChatLayout from "./components/layout/ChatLayout.svelte";
	import PinPage from "./pages/PinPage.svelte";
	import DashboardPage from "./pages/DashboardPage.svelte";
	import SetupPage from "./pages/SetupPage.svelte";

	const route = $derived(getCurrentRoute());
</script>

{#if route.page === "chat"}
	<ChatLayout />
{:else if route.page === "dashboard"}
	<DashboardPage />
{:else if route.page === "auth"}
	<PinPage />
{:else if route.page === "setup"}
	<SetupPage />
{/if}

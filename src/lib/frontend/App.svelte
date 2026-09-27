<!-- ─── App Root ────────────────────────────────────────────────────────────── -->
<!-- Root component with client-side routing. Renders the appropriate page -->
<!-- based on the current URL path. -->

<script lang="ts">
	import { getCurrentRoute, normalizeRoute } from "./stores/router.svelte.js";
	import ChatLayout from "./components/layout/ChatLayout.svelte";
	import PinPage from "./pages/PinPage.svelte";
	import SetupPage from "./pages/SetupPage.svelte";
	import ConfirmModal from "./components/overlays/ConfirmModal.svelte";

	const route = $derived(getCurrentRoute());
	$effect(() => normalizeRoute());
</script>

{#if route.page === "chat"}
	<ChatLayout />
{:else if route.page === "auth"}
	<PinPage />
{:else if route.page === "setup"}
	<SetupPage />
{/if}

<ConfirmModal />

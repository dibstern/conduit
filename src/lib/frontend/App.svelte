<!-- Root component with client-side routing. Renders the appropriate page -->
<!-- based on the current URL path. -->

<script lang="ts">
	import { getCurrentRoute, normalizeRoute } from "./stores/router.svelte.js";
	import ChatLayout from "./components/layout/ChatLayout.svelte";
	import PinPage from "./pages/PinPage.svelte";
	import SetupPage from "./pages/SetupPage.svelte";
	import ConfirmModal from "./components/overlays/ConfirmModal.svelte";
	import SnoozePickerHost from "./components/session/SnoozePickerHost.svelte";

	const route = $derived(getCurrentRoute());
	// Pre, so a legacy /p/<slug>/ address is already ?p=<slug> when ChatLayout
	// mounts and opens the daemon socket. A plain $effect runs after children
	// mount, and the socket then attaches the daemon's first project instead.
	$effect.pre(() => normalizeRoute());
</script>

{#if route.page === "chat"}
	<ChatLayout />
{:else if route.page === "auth"}
	<PinPage />
{:else if route.page === "setup"}
	<SetupPage />
{/if}

<ConfirmModal />
<SnoozePickerHost />

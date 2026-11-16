<!-- Root component with client-side routing. Renders the appropriate page -->
<!-- based on the current URL path. -->

<script lang="ts">
	import { BUILD_ID } from "../build-id.js";
	import { getCurrentRoute, normalizeRoute } from "./stores/router.svelte.js";
	import ChatLayout from "./components/layout/ChatLayout.svelte";
	import ConfirmModal from "./components/overlays/ConfirmModal.svelte";
	import SnoozePickerHost from "./components/session/SnoozePickerHost.svelte";
	import HandoffReviewHost from "./components/overlays/HandoffReviewHost.svelte";

	const route = $derived(getCurrentRoute());

	// A tab loaded before a rebuild asks for page chunks the server no longer
	// has, and an await without a catch renders nothing. These pages hold no
	// socket to learn of the new build, so reload once per build into it.
	function reloadOnMissingChunk(error: unknown): Promise<never> {
		try {
			const key = `conduit-chunk-reload:${BUILD_ID}`;
			if (!sessionStorage.getItem(key)) {
				sessionStorage.setItem(key, "1");
				location.reload();
				return new Promise<never>(() => {});
			}
		} catch {
			// Storage unavailable: fail rather than risk a reload loop.
		}
		return Promise.reject(error);
	}
	// Pre, so a legacy /p/<slug>/ address is already ?p=<slug> when ChatLayout
	// mounts and opens the daemon socket. A plain $effect runs after children
	// mount, and the socket then attaches the daemon's first project instead.
	$effect.pre(() => normalizeRoute());
</script>

{#if route.page === "chat"}
	<ChatLayout />
{:else if route.page === "auth"}
	{#await import("./pages/PinPage.svelte").catch(reloadOnMissingChunk) then { default: PinPage }}
		<PinPage />
	{/await}
{:else if route.page === "setup"}
	{#await import("./pages/SetupPage.svelte").catch(reloadOnMissingChunk) then { default: SetupPage }}
		<SetupPage />
	{/await}
{/if}

<ConfirmModal />
<SnoozePickerHost />
<HandoffReviewHost />

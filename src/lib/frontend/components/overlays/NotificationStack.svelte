<!--
  NotificationStack — the app's notifications: AttentionBanner items fixed
  top-right, toasts anchored bottom-right (a bottom sheet on phones) so they
  never cover the session bar's controls.
-->
<script lang="ts">
	import AttentionBanner from "../permissions/AttentionBanner.svelte";
	import Toast from "./Toast.svelte";
</script>

<div class="fixed top-16 right-4 z-[var(--z-toast)] max-w-[320px] flex flex-col gap-2 pointer-events-none">
	<AttentionBanner />
</div>
<Toast />

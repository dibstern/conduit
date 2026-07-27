<!--
  NotificationStack — Unified notification container, fixed top-right.
  Renders AttentionBanner items above Toast items in a vertical stack.
-->
<script lang="ts">
	import AttentionBanner from "../permissions/AttentionBanner.svelte";
	import Toast from "./Toast.svelte";
</script>

<div class="fixed top-16 right-4 z-[var(--z-toast)] max-w-[320px] flex flex-col gap-2 pointer-events-none">
	<AttentionBanner />
	<Toast />
</div>

<script lang="ts">
	import type { SessionPermissionMode } from "../../types.js";
	import { PERMISSION_MODE_COLOURS } from "../../permission-modes.js";

	let { mode, size = 18, detailed = true }: { mode: SessionPermissionMode; size?: number; detailed?: boolean } = $props();
	const tone = $derived(PERMISSION_MODE_COLOURS[mode]);
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style:color={tone}>
	{#if mode === "plan"}
		<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none" />
	{:else}
	<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none" />
	{#if detailed}
		{#if mode === "dontAsk"}
			<path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		{:else if mode === "ask"}
			<path d="M10.1 10.2a1.95 1.95 0 113.2 1.5c-.75.55-1.3.95-1.3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" />
			<circle cx="12" cy="16.2" r="1" fill="currentColor" />
		{:else if mode === "acceptEdits"}
			<path d="M9.4 15.4l.5-2.3 3.9-3.9 1.8 1.8-3.9 3.9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none" />
		{:else if mode === "auto"}
			<path d="M12.9 7.9l-3.3 4.6h2.7l-.9 3.6 3.3-4.6h-2.7z" fill="currentColor" />
		{:else if mode === "full"}
			<path d="M12 8v4.7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
			<circle cx="12" cy="15.9" r="1.2" fill="currentColor" />
		{/if}
	{/if}
	{/if}
</svg>

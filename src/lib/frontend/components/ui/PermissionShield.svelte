<script lang="ts">
	import type { SessionPermissionMode } from "../../types.js";
	import { PERMISSION_MODE_COLOURS } from "../../permission-modes.js";

	let { mode, size = 18, detailed = true }: { mode: SessionPermissionMode; size?: number; detailed?: boolean } = $props();
	const id = $props.id();
	const tone = $derived(PERMISSION_MODE_COLOURS[mode]);
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style:color={tone}>
	<defs>
		<mask id={`${id}-glyph`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
			<rect width="24" height="24" fill="white" />
			{#if detailed}
				<g stroke="black" stroke-linecap="round" stroke-linejoin="round" fill="none">
					{#if mode === "plan"}
						<path d="M8 7h8M8 11h6M6.5 17.5H20" stroke-width="1.5" />
					{:else if mode === "dontAsk"}
						<path d="M9 12h6" stroke-width="2" />
					{:else if mode === "ask"}
						<path d="M10.1 10.2a1.95 1.95 0 113.2 1.5c-.75.55-1.3.95-1.3 2" stroke-width="1.7" />
						<circle cx="12" cy="16.2" r="1" stroke="none" fill="black" />
					{:else if mode === "acceptEdits"}
						<path d="M9.4 15.4l.5-2.3 3.9-3.9 1.8 1.8-3.9 3.9z" stroke-width="1.5" />
					{:else if mode === "auto"}
						<path d="M12.9 7.9l-3.3 4.6h2.7l-.9 3.6 3.3-4.6h-2.7z" stroke="none" fill="black" />
					{:else if mode === "full"}
						<path d="M12 8v4.7" stroke-width="2.2" />
						<circle cx="12" cy="15.9" r="1.2" stroke="none" fill="black" />
					{/if}
				</g>
			{/if}
		</mask>
	</defs>
	<path data-part="body" d={mode === "plan"
		? "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"
		: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"}
		fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" mask={`url(#${id}-glyph)`} />
</svg>

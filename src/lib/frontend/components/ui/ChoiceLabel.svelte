<script lang="ts">
	import type { Snippet } from "svelte";
	let { forId, selected = false, disabled = false, class: className = "", children }: {
		forId: string;
		selected?: boolean;
		disabled?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<label for={forId} class="flex min-h-[44px] items-start gap-[8px] rounded-[6px] border px-[10px] py-[8px] text-[13px] transition-colors {selected ? 'border-text-muted bg-selection' : 'border-border-subtle bg-bg-surface'} {disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover'} {className}">
	{@render children()}
</label>

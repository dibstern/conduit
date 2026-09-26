<script lang="ts">
	import Modal from "../ui/Modal.svelte";

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	const shortcuts = [
		["j / k", "Next / previous session"],
		["Enter", "Open focused session"],
		["s", "Settle / un-settle"],
		["z", "Snooze / unsnooze"],
		["p", "Pin / unpin"],
		["u", "Mark read / unread"],
		["r", "Rename session"],
		["1–9 / 0", "Project scope / all projects"],
		["/", "Search sessions"],
		["⌘P", "Choose project scope"],
		["⌘⇧U", "Open session read / unread"],
		["⌘Z", "Undo latest action"],
		["?", "Show keyboard shortcuts"],
		["Esc", "Close menu or sheet"],
	] as const;
</script>

{#snippet body()}
	<dl data-testid="shortcut-sheet" class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm font-brand">
		{#each shortcuts as [key, verb] (key)}
			<dt class="font-mono text-text whitespace-nowrap">{key}</dt>
			<dd class="text-text-secondary">{verb}</dd>
		{/each}
	</dl>
{/snippet}

<Modal {open} {onclose} title="Keyboard shortcuts" size="sm" children={body} />

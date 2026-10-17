<script lang="ts">
	import Menu from "../Menu.svelte";
	import LabelledGridGroup from "../LabelledGridGroup.svelte";
	import Tile from "../Tile.svelte";
	import SwitchRow from "../SwitchRow.svelte";
	import SheetFooter from "../SheetFooter.svelte";

	const { mode = "tiles", shape = "square", checked = false, saving = false, held = false, initiallyOpen = true }: {
		mode?: "tiles" | "grid" | "switch" | "footer";
		shape?: "square" | "wide";
		checked?: boolean;
		saving?: boolean;
		held?: boolean;
		initiallyOpen?: boolean;
	} = $props();
	// Story args are fixed per story, so seeding local state from them once is the intent.
	// svelte-ignore state_referenced_locally
	let open = $state(initiallyOpen);
	// svelte-ignore state_referenced_locally
	let enabled = $state(checked);
	let picked = $state("");
</script>

<output data-testid="sheet-picked" class="sr-only">{picked}</output>
<!-- The footer story pins a 30px home-indicator inset, so the footer is seen clearing it. -->
{#snippet actions()}
	<SheetFooter actions={[
		{ label: "Share", icon: "share", onselect: () => { picked = "Share"; } },
		{ label: "Settings", icon: "settings", onselect: () => { picked = "Settings"; } },
		{ label: "Debug", icon: "bug", tag: "dev", onselect: () => { picked = "Debug"; } },
	]} />
{/snippet}

<Menu bind:open presentation="sheet" ariaLabel="Session actions" footer={mode === "footer" ? actions : undefined} class={mode === "footer" ? "[--sheet-safe-area-bottom:30px]" : undefined}>
	{#snippet trigger({ props })}<button {...props} class="min-h-[44px] px-[16px] text-text">Open session actions</button>{/snippet}
	{#snippet children()}
		<div class="px-[16px]">
			{#if mode === "switch"}
				<SwitchRow bind:checked={enabled} {saving} label="Auto-settle" description={enabled ? "settles after 3 days idle" : "stays until you settle it"} />
			{:else}
				<LabelledGridGroup label="Triage">
					<Tile {shape} icon="check" label="Settle" variant="primary" onselect={() => { picked = "Settle"; }} />
					<Tile {shape} icon="moon" label="Snooze" tag="hold" {held} />
					<Tile {shape} icon="undo" label="Unsnooze" />
					<Tile {shape} icon="circle-dot" label="Unread" />
				</LabelledGridGroup>
				{#if mode !== "grid"}
					<SwitchRow checked label="Auto-settle" description="settles after 3 days idle" />
					<LabelledGridGroup label="Session">
						<Tile {shape} icon="pencil" label="Rename" />
						<Tile {shape} icon="git-fork" label="Fork" disabled subLine="Session busy" />
						<Tile {shape} icon="copy" label="Copy resume" subLine="claude --resume" />
						<Tile {shape} icon="trash-2" label="Delete…" variant="danger" />
					</LabelledGridGroup>
				{/if}
				{#if mode === "footer"}
					{#each Array.from({ length: 12 }, (_, i) => i + 1) as n (n)}
						<LabelledGridGroup label={`More actions ${n}`}>
							<Tile icon="folder" label={`Archive ${n}`} />
							<Tile icon="copy" label={`Copy ${n}`} />
						</LabelledGridGroup>
					{/each}
				{/if}
			{/if}
		</div>
	{/snippet}
</Menu>

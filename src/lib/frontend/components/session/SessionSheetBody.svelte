<script lang="ts">
	import { dismissToast, showToast, uiState } from "../../stores/ui.svelte.js";
	import LabelledGridGroup from "../ui/LabelledGridGroup.svelte";
	import SheetNotice from "../ui/SheetNotice.svelte";
	import SwitchRow from "../ui/SwitchRow.svelte";
	import Tile from "../ui/Tile.svelte";
	import type { SessionCommand, SessionCommandEntry } from "./session-commands.js";

	let { commands, onselect }: {
		commands: readonly SessionCommandEntry[];
		onselect: (run: SessionCommand["run"]) => void;
	} = $props();
	const triage = $derived(commands.filter((item) => item.section === "triage" && item.checked === undefined));
	const switches = $derived(commands.filter((item) => item.checked !== undefined));
	const session = $derived(commands.filter((item) => item.section === "manage" || item.section === "danger"));
	const toastHost = Symbol("session-sheet");
	$effect(() => {
		uiState.sheetToastHost = toastHost;
		return () => { if (uiState.sheetToastHost === toastHost) uiState.sheetToastHost = null; };
	});
</script>

{#snippet tile(item: SessionCommandEntry)}
	<Tile
		data-testid={item.testId}
		aria-label={item.label}
		label={item.shortLabel ?? item.label}
		icon={item.icon}
		subLine={item.detail ?? undefined}
		variant={item.danger ? "danger" : item.emphasis ?? "default"}
		disabledReason={item.disabledReason}
		ondisabledselect={() => { if (item.disabledReason) showToast(item.disabledReason, { variant: "pinned" }); }}
		onselect={() => onselect(item.run)}
	/>
{/snippet}

<div class="px-[16px]" data-session-sheet-body>
	<LabelledGridGroup label="Triage">
		{#each triage as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
	{#each switches as item (item.testId)}
		<SwitchRow data-testid={item.testId} aria-label={item.label} label={item.shortLabel ?? item.label} icon={item.icon} checked={item.checked ?? false} controlled showState={false} oncheckedchange={() => item.run()} />
	{/each}
	<LabelledGridGroup label="Session" columns={session.length > 4 ? 5 : 4}>
		{#each session as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
	{#if uiState.sheetToastHost === toastHost && uiState.toasts.length > 0}
		<div class="sticky bottom-0 z-[var(--z-raised)] bg-bg-surface pb-[4px]">
			{#each [...uiState.toasts].reverse() as toast (toast.id)}
				<SheetNotice
					message={toast.title}
					body={toast.body}
					emphasis={toast.emphasis}
					variant={toast.variant}
					actions={toast.actions.map((action) => ({ label: action.label, run: () => { try { action.run?.(); } finally { dismissToast(toast.id); } } }))}
				/>
			{/each}
		</div>
	{/if}
</div>

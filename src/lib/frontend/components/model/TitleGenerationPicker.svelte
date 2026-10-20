<script lang="ts">
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SheetChrome from "../ui/SheetChrome.svelte";
	import Surface from "../ui/Surface.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import ModelSelectionPanel from "./ModelSelectionPanel.svelte";
	import { createModelSelectionState } from "./model-selection.svelte.js";
	import { createTitleModelSelectionTarget } from "./title-model-selection-target.svelte.js";

	const setting = createTitleModelSelectionTarget();
	const target = setting.target;
	const selection = createModelSelectionState(() => target);
	const groupHeadingId = $props.id();
	const titleId = `${groupHeadingId}-title`;
	let open = $state(false);
	let view = $state("root");
	let searchQuery = $state("");
	let trigger: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	const selectedLabel = $derived(target.accounts.find((account) => account.id === target.pick.account)?.label ?? "Claude account");
	const summary = $derived(`${selectedLabel} · ${selection.displayName}${target.pick.effort ? ` · ${target.pick.effort}` : ""}`);
</script>

<SettingsRow label="Title generation" description="Used to generate session titles for every project." testId="settings-title-generation">
	{#snippet control()}
		<Button
			bind:element={trigger}
			variant="secondary"
			size="sm"
			ariaLabel="Choose title generation model"
			aria-haspopup="dialog"
			aria-expanded={open}
			data-testid="settings-title-generation-picker"
			class="max-w-[300px] max-md:max-w-[calc(100vw-100px)]"
			disabled={setting.saving}
			onclick={() => { view = "root"; searchQuery = ""; setting.refreshCatalog(); open = true; }}
		>
			<span class="truncate">{summary}</span>
		</Button>
		{#if discoveryState.titleGeneration.selection}
			<TextButton data-testid="settings-title-generation-reset" disabled={setting.saving} onclick={setting.reset}>Reset</TextButton>
		{/if}
	{/snippet}
</SettingsRow>

<Dialog {open} onclose={() => (open = false)} labelledBy={titleId} placement={sessionViewState.compact ? "sheet" : "center"} returnFocus={() => trigger ?? null}>
	<SheetChrome active={sessionViewState.compact} maxHeight="85dvh" bottomPadding={30} safeAreaMode="max" bodyClass="flex flex-col">
		<Surface
			variant={sessionViewState.compact ? "bare" : "popover"}
			radius="none"
			elevation={sessionViewState.compact ? "none" : "popover"}
			id="title-generation-picker"
			data-testid="title-generation-picker"
			aria-busy={setting.saving || target.inventory.loading}
			class="model-dropdown flex flex-col overflow-hidden p-[6px] font-sans {sessionViewState.compact ? 'w-full min-h-0' : 'w-[404px] max-w-[90vw] max-h-[min(70vh,480px)] rounded-[16px]'}"
		>
			<ModelSelectionPanel {target} {titleId} {groupHeadingId} {selectedLabel} title={view === "root" ? "Title generation" : "Model"} contextLabel="" bind:view bind:searchQuery>
				{#snippet subtitle()}
					<Button variant="ghost" size="content" iconOnly icon="x" iconSize={14} ariaLabel="Close title generation picker" class="ml-auto h-7 w-7 rounded-lg" onclick={() => (open = false)} />
				{/snippet}
				{#snippet modelNotice()}
					{#if target.inventory.error}<p class="px-[10px] py-2 text-[12px] text-error">{target.inventory.error}</p>{/if}
				{/snippet}
			</ModelSelectionPanel>
		</Surface>
	</SheetChrome>
</Dialog>

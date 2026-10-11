<script lang="ts">
	import EffortMeter from "../ui/EffortMeter.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MicroLabelButton from "../ui/MicroLabelButton.svelte";
	import { effort } from "../../stores/composer-settings.svelte.js";
	import { composerPickerState, openPicker } from "../../stores/composer-picker.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";

	let { onOpen, variant = "icons" }: {
		onOpen?: (() => void) | undefined;
		variant?: "icons" | "words" | "control" | undefined;
	} = $props();

	let open = $state(false);
	const phone = $derived(sessionViewState.composerTier === "phone");
	const variants = $derived(effort.options);
	const currentVariant = $derived(effort.current ?? "");
	const filled = $derived(currentVariant ? variants.indexOf(currentVariant) + 1 : 0);

	const knownLevels = [
		{ value: "low", name: "Low", label: "LOW", description: "Quick, light reasoning" },
		{ value: "medium", name: "Medium", label: "MED", description: "Balanced" },
		{ value: "high", name: "High", label: "HIGH", description: "Thinks harder, slower" },
		{ value: "xhigh", name: "Extra high", label: "XHIGH", description: "Deeper still, for hard problems" },
		{ value: "max", name: "Max", label: "MAX", description: "Most thorough, slowest" },
	];
	const currentLevel = $derived(knownLevels.find((level) => level.value === currentVariant));
	const levelName = $derived(currentLevel?.name ?? (currentVariant || "Default"));
	const microLabel = $derived(
		currentLevel?.label ?? (currentVariant ? currentVariant.slice(0, 5).toUpperCase() : "DEF"),
	);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key.toLowerCase() === "t" && e.ctrlKey && variants.length > 0) {
			e.preventDefault();
			if (!effort.pending) effort.cycle();
		}
	}

	function openMenu() {
		onOpen?.();
		open = true;
	}

	/** Close the dropdown (called by parent for mutual exclusion). */
	export function close() {
		open = false;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if variants.length > 0 && variant === "words"}
		<Button
			variant="ghost"
			size="content"
			tone="muted"
			hoverFill="none"
			class="shrink-0 text-[11.5px] font-normal font-brand"
			ariaLabel={`Effort: ${levelName}. Open effort options`}
			loading={effort.pending}
			aria-haspopup="dialog"
			aria-expanded={composerPickerState.request !== null}
			aria-controls={composerPickerState.request ? "model-picker" : undefined}
			data-testid="composer-word-effort"
			onclick={(event) => {
				openPicker("effort");
				if (composerPickerState.request && event.currentTarget instanceof HTMLElement) composerPickerState.request.opener = event.currentTarget;
			}}
		><span class="border-b border-dotted border-border-chip">{currentVariant ? microLabel.toLowerCase() : microLabel}</span></Button>
{:else if variants.length > 0 && variant === "control"}
	<Button
		variant="ghost"
		size="content"
		tone="inherit"
		hoverFill="none"
		class="h-[26px] shrink-0 gap-[5px] rounded-[7px] px-[6px] text-[11.5px] font-normal font-brand text-text-secondary whitespace-nowrap hover:bg-text/7"
		ariaLabel={`Effort: ${levelName}. Open effort options`}
		loading={effort.pending}
		aria-haspopup="dialog"
		aria-expanded={composerPickerState.request !== null}
		aria-controls={composerPickerState.request ? "model-picker" : undefined}
		data-testid="variant-badge"
		title="Effort {levelName}. Ctrl+T to cycle"
		onclick={(event) => {
			openPicker("effort");
			if (composerPickerState.request && event.currentTarget instanceof HTMLElement) composerPickerState.request.opener = event.currentTarget;
		}}
	>
		<EffortMeter levels={variants.length} {filled} />
		{#if sessionViewState.composerTier === "wide"}<span data-testid="composer-effort-label">{levelName}</span>{/if}
	</Button>
{:else if variants.length > 0}
	<Menu
		bind:open
		onopenchange={(nextOpen) => { if (nextOpen) onOpen?.(); }}
		ariaLabel="Reasoning effort"
		side="top"
		align="end"
		class="w-[236px]"
		data-testid="variant-dropdown"
	>
		{#snippet trigger({ props })}
			{#if phone}
				<!-- Keep Bits' trigger attributes and ref; MicroLabelButton owns tap,
				     hold and keyboard activation instead of Bits' eager menu handlers. -->
				<MicroLabelButton
					{...props}
					onpointerdown={undefined}
					onpointerup={undefined}
					onkeydown={undefined}
					variant="micro"
					label={microLabel}
					tone="var(--color-text-secondary)"
					accessibleName="Effort {levelName}. Tap or Ctrl+T to cycle; hold or Shift+F10 for options"
					pending={effort.pending}
					pulseKey={currentVariant}
					onTap={() => effort.cycle()}
					onHold={openMenu}
					data-testid="variant-badge"
					title="Effort {levelName}. Ctrl+T to cycle"
				>
					<EffortMeter levels={variants.length} {filled} />
				</MicroLabelButton>
			{:else}
				<MicroLabelButton
					{...props}
					onpointerdown={undefined}
					onpointerup={undefined}
					variant="chip"
					label={levelName}
					accessibleName="Effort {levelName}"
					pending={effort.pending}
					onTap={openMenu}
					data-testid="variant-badge"
					title="Effort {levelName}. Ctrl+T to cycle"
				>
					<EffortMeter levels={variants.length} {filled} />
				</MicroLabelButton>
			{/if}
		{/snippet}

		<MenuRadioGroup value={currentVariant}>
			<MenuRadioItem
				value=""
				disabled={effort.pending}
				data-testid="variant-option-default"
				onselect={() => { effort.select(null); open = false; }}
			>
				<span class="grid grid-cols-[28px_1fr] items-center gap-x-1.5">
					<span class="row-span-2 justify-self-center"><EffortMeter levels={variants.length} filled={0} /></span>
					<span class="font-brand font-semibold">Default</span>
					<span class="text-xs text-text-muted">Use the model default</span>
				</span>
			</MenuRadioItem>
			{#each variants as v, index (v)}
				{@const level = knownLevels.find((known) => known.value === v)}
				<MenuRadioItem
					value={v}
					disabled={effort.pending}
					data-testid="variant-option-{v}"
					onselect={() => { effort.select(v); open = false; }}
				>
					<span class="grid grid-cols-[28px_1fr] items-center gap-x-1.5">
						<span class="row-span-2 justify-self-center"><EffortMeter levels={variants.length} filled={index + 1} /></span>
						<span class="font-brand font-semibold">{level?.name ?? v}</span>
						<span class="text-xs text-text-muted">{level?.description ?? "Custom reasoning effort"}</span>
					</span>
				</MenuRadioItem>
			{/each}
		</MenuRadioGroup>
	</Menu>
{/if}

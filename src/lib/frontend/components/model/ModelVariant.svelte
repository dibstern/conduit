<script lang="ts">
	import type { Snippet } from "svelte";
	import EffortMeter from "../ui/EffortMeter.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MicroLabelButton from "../ui/MicroLabelButton.svelte";
	import { effort } from "../../stores/composer-settings.svelte.js";
	import { composerPickerState, openPicker } from "../../stores/composer-picker.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { getActiveModel } from "../../stores/discovery.svelte.js";
	import { resolveModelParameters } from "./model-parameters.js";

	let { onOpen, variant = "icons", children, wordLabel }: {
		onOpen?: (() => void) | undefined;
		variant?: "icons" | "words" | "control" | "row" | undefined;
		children?: Snippet<[row: Snippet]> | undefined;
		wordLabel?: string | undefined;
	} = $props();

	let open = $state(false);
	const phone = $derived(sessionViewState.composerTier === "phone");
	const variants = $derived(effort.options);
	const currentVariant = $derived(effort.current ?? "");
	const activeModel = $derived(getActiveModel());
	const parameters = $derived(activeModel?.parameters);
	const parameterState = $derived(resolveModelParameters(activeModel, effort.current));
	const parameterEffort = $derived(parameterState.rows.find((row) => row.kind === "effort"));
	const levels = $derived(parameters ? parameterEffort?.options.length ?? 0 : variants.length);
	const currentEffort = $derived(parameters && !parameterState.variantUnavailable ? parameterEffort?.value ?? "" : currentVariant);
	const displayedWord = $derived(parameters && parameterState.variantUnavailable ? currentVariant : wordLabel);
	const showEffort = $derived(variants.length > 0 || (!!sessionState.currentId && !!currentVariant));
	const filled = $derived(parameters
		? parameterState.variantUnavailable ? 0 : (parameterEffort?.options.findIndex((option) => option.value === currentEffort) ?? -1) + 1
		: currentVariant ? variants.indexOf(currentVariant) + 1 : 0);

	const knownLevels = [
		{ value: "low", name: "Low", label: "LOW", description: "Quick, light reasoning" },
		{ value: "medium", name: "Medium", label: "MEDIUM", description: "Balanced" },
		{ value: "high", name: "High", label: "HIGH", description: "Thinks harder, slower" },
		{ value: "xhigh", name: "Extra high", label: "XHIGH", description: "Deeper still, for hard problems" },
		{ value: "max", name: "Max", label: "MAX", description: "Most thorough, slowest" },
	];
	const currentLevel = $derived(knownLevels.find((level) => level.value === currentEffort));
	const levelName = $derived(currentLevel?.name ?? (currentEffort || (parameters ? displayedWord : undefined) || "Default"));
	const microLabel = $derived(
		currentLevel?.label ?? (currentEffort ? currentEffort.slice(0, 5).toUpperCase() : "DEF"),
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

{#snippet effortRow()}
		<Button
			variant="composer-row" size="content"
			ariaLabel={`Effort: ${displayedWord ?? levelName}. Open effort options`}
			loading={effort.pending}
			disabled={variants.length === 0}
			aria-haspopup="dialog"
			data-testid="composer-more-effort"
			onclick={() => openPicker("effort")}
		>
			<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Effort</span>
			<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[7px] font-semibold">{#if !parameters || levels > 0}<EffortMeter {levels} {filled} />{/if}{displayedWord ?? (variants.length === 0 && !currentVariant ? "Unavailable" : parameters ? levelName : currentVariant || "Default")}</span>
			<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
		</Button>
{/snippet}

{#if variant === "row"}
	{#if children}{@render children(effortRow)}{:else}{@render effortRow()}{/if}
{:else if showEffort && variant === "words"}
		<Button
			variant="composer-word"
			size="content"
			class="shrink-0"
			ariaLabel={`Effort: ${displayedWord ?? levelName}. Open effort options`}
			loading={effort.pending}
			disabled={variants.length === 0}
			aria-haspopup="dialog"
			aria-expanded={composerPickerState.request !== null}
			aria-controls={composerPickerState.request ? "model-picker" : undefined}
			data-testid="composer-word-effort"
			onclick={(event) => {
				openPicker("effort");
				if (composerPickerState.request && event.currentTarget instanceof HTMLElement) composerPickerState.request.opener = event.currentTarget;
			}}
		><span>{displayedWord ?? (parameters ? currentEffort || levelName : currentVariant || "default")}</span></Button>
{:else if showEffort && variant === "control" && sessionViewState.composerWidth >= 480}
	<Button
		variant="composer-model"
		size="composer-chip"
		class="shrink-0"
		ariaLabel={`Effort: ${levelName}. Open effort options`}
		loading={effort.pending}
		disabled={variants.length === 0}
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
		{#if !parameters || levels > 0}<EffortMeter {levels} {filled} />{/if}
		{#if sessionViewState.composerTier === "wide" || levels === 0}<span data-testid="composer-effort-label">{levelName}</span>{/if}
	</Button>
{:else if showEffort && variant !== "control"}
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
					disabled={variants.length === 0}
					pulseKey={currentVariant}
					onTap={() => effort.cycle()}
					onHold={openMenu}
					data-testid="variant-badge"
					title="Effort {levelName}. Ctrl+T to cycle"
				>
					{#if !parameters || levels > 0}<EffortMeter {levels} {filled} />{/if}
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
					disabled={variants.length === 0}
					onTap={openMenu}
					data-testid="variant-badge"
					title="Effort {levelName}. Ctrl+T to cycle"
				>
					{#if !parameters || levels > 0}<EffortMeter {levels} {filled} />{/if}
				</MicroLabelButton>
			{/if}
		{/snippet}

		<MenuRadioGroup value={currentVariant}>
			<MenuRadioItem
				value=""
				disabled={effort.pending || variants.length === 0}
				data-testid="variant-option-default"
				onselect={() => { effort.select(null); open = false; }}
			>
				<span class="grid grid-cols-[28px_1fr] items-center gap-x-1.5">
					<span class="row-span-2 justify-self-center">{#if !parameters || levels > 0}<EffortMeter {levels} filled={0} />{/if}</span>
					<span class="font-sans font-semibold">Default</span>
					<span class="text-xs text-text-muted">Use the model default</span>
				</span>
			</MenuRadioItem>
			{#if !parameters}
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
							<span class="font-sans font-semibold">{level?.name ?? v}</span>
							<span class="text-xs text-text-muted">{level?.description ?? "Custom reasoning effort"}</span>
						</span>
					</MenuRadioItem>
				{/each}
			{/if}
		</MenuRadioGroup>
		{#if parameters}
			{#each parameterState.rows as row (row.id)}
				<MenuGroup label={row.title}>
					<MenuRadioGroup value={row.value} aria-label={row.title}>
						{#each row.options as option (option.value)}
							<MenuRadioItem
								value={option.value}
								disabled={effort.pending || option.disabled}
								data-testid="variant-{row.kind}-option-{option.value}"
								onselect={() => {
									const choice = parameterState.withValue(row.id, option.value);
									if (choice !== undefined && !effort.pending) effort.select(choice);
									open = false;
								}}
							>{option.label}</MenuRadioItem>
						{/each}
					</MenuRadioGroup>
				</MenuGroup>
			{/each}
		{/if}
	</Menu>
{/if}

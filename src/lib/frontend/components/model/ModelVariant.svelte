<script lang="ts">
	import EffortMeter from "../ui/EffortMeter.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MicroLabelButton from "../ui/MicroLabelButton.svelte";
	import { effort } from "../../stores/composer-settings.svelte.js";

	let { onOpen, variant = "icons" }: {
		onOpen?: (() => void) | undefined;
		variant?: "icons" | "words" | undefined;
	} = $props();

	let open = $state(false);
	let innerWidth = $state(window.innerWidth);
	const phone = $derived(innerWidth < 768);
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

<svelte:window bind:innerWidth onkeydown={handleKeydown} />

{#if variants.length > 0}
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
			{#if phone || variant === "words"}
				<!-- Keep Bits' trigger attributes and ref; MicroLabelButton owns tap,
				     hold and keyboard activation instead of Bits' eager menu handlers. -->
				<MicroLabelButton
					{...props}
					onpointerdown={undefined}
					onpointerup={undefined}
					onkeydown={undefined}
					variant={variant === "words" ? "words" : "micro"}
					label={variant === "words" && currentVariant ? microLabel.toLowerCase() : microLabel}
					tone={variant === "words" ? "var(--color-text-muted)" : "var(--color-text-secondary)"}
					accessibleName="Effort {levelName}. Tap or Ctrl+T to cycle; hold or Shift+F10 for options"
					pending={effort.pending}
					pulseKey={currentVariant}
					onTap={() => effort.cycle()}
					onHold={openMenu}
					data-testid={variant === "words" ? "composer-word-effort" : "variant-badge"}
					title="Effort {levelName}. Ctrl+T to cycle"
				>
					{#if variant === "icons"}<EffortMeter levels={variants.length} {filled} />{/if}
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

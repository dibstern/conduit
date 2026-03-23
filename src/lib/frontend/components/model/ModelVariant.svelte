<!-- ─── Model Variant Picker ─────────────────────────────────────────────── -->
<!-- Thinking level badge + dropdown for cycling model variants. -->
<!-- Manages its own dropdown state, outside-click, and Ctrl+T shortcut. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import {
		discoveryState,
		getActiveModelVariants,
	} from "../../stores/discovery.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let { onOpen }: { onOpen?: () => void } = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let variantDropdownOpen = $state(false);

	// ─── Derived ────────────────────────────────────────────────────────────────

	/** Available variants for the active model. */
	const variants = $derived(getActiveModelVariants());

	/** Current variant label. */
	const currentVariant = $derived(discoveryState.currentVariant);

	/** Display label for the variant badge. */
	const variantLabel = $derived(currentVariant || "default");

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function toggleVariantDropdown(e: MouseEvent) {
		e.stopPropagation();
		onOpen?.();
		variantDropdownOpen = !variantDropdownOpen;
	}

	function selectVariant(variant: string, e: MouseEvent) {
		e.stopPropagation();
		wsSend({ type: "switch_variant", variant });
		discoveryState.currentVariant = variant;
		variantDropdownOpen = false;
	}

	function cycleVariant() {
		// Cycle: default → low → medium → high → max → default
		const cycle = ["", ...variants];
		const currentIdx = cycle.indexOf(currentVariant);
		const nextIdx = (currentIdx + 1) % cycle.length;
		// biome-ignore lint/style/noNonNullAssertion: index is always valid (modulo cycle.length)
		const next = cycle[nextIdx]!;
		wsSend({ type: "switch_variant", variant: next });
		discoveryState.currentVariant = next;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && variantDropdownOpen) {
			variantDropdownOpen = false;
			return;
		}
		if (e.key === "t" && e.ctrlKey && variants.length > 0) {
			e.preventDefault();
			cycleVariant();
		}
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("keydown", handleKeydown);
		};
	});

	// ─── Public API ─────────────────────────────────────────────────────────────

	/** Close the dropdown (called by parent for mutual exclusion). */
	export function close() {
		variantDropdownOpen = false;
	}
</script>

{#if variants.length > 0}
	<div class="relative" use:clickOutside={() => { variantDropdownOpen = false; }}>
		<button
			data-testid="variant-badge"
		class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border border-border bg-bg-alt text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 hover:bg-bg hover:text-text-secondary font-brand"
			title="Thinking level ({variantLabel}) — Ctrl+T to cycle"
			onclick={toggleVariantDropdown}
		>
			{variantLabel}
			<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
		</button>

		<!-- Variant dropdown -->
		{#if variantDropdownOpen}
			<div
				data-testid="variant-dropdown"
			class="absolute bottom-[calc(100%+4px)] right-0 w-40 bg-bg-alt border border-border rounded-lg shadow-[0_-4px_16px_rgba(var(--shadow-rgb),0.3)] z-[210] py-1 font-brand"
			>
				<!-- Default option (clears variant) -->
				<button
					data-testid="variant-option-default"
					class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentVariant === '' ? 'text-accent' : ''}"
					onclick={(e) => selectVariant("", e)}
				>
					{#if currentVariant === ""}
						<span class="text-accent font-bold text-xs">&#10003;</span>
					{:else}
						<span class="w-[10px]"></span>
					{/if}
					default
				</button>

				<!-- Variant options -->
				{#each variants as v (v)}
					<button
						data-testid="variant-option-{v}"
						class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentVariant === v ? 'text-accent' : ''}"
						onclick={(e) => selectVariant(v, e)}
					>
						{#if currentVariant === v}
							<span class="text-accent font-bold text-xs">&#10003;</span>
						{:else}
							<span class="w-[10px]"></span>
						{/if}
						{v}
					</button>
				{/each}

				<!-- Footer hint -->
				<div class="border-t border-border mt-1 pt-1 px-3 pb-1 text-xs text-text-dimmer">
					Ctrl+T to cycle
				</div>
			</div>
		{/if}
	</div>
{/if}

<!-- ─── Model Variant Picker ─────────────────────────────────────────────── -->
<!-- Thinking level badge + dropdown for cycling model variants. -->
<!-- Uses the shared menu and keeps the Ctrl+T shortcut. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import {
		discoveryState,
		getActiveModelVariants,
	} from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { switchVariantRpc } from "../../transport/ws-rpc-client.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let { onOpen }: { onOpen?: (() => void) | undefined } = $props();

	const variantState: { availableVariants: readonly string[] } = discoveryState;

	// ─── State ──────────────────────────────────────────────────────────────────

	let open = $state(false);

	// ─── Derived ────────────────────────────────────────────────────────────────

	/** Available variants for the active model. */
	const variants = $derived(getActiveModelVariants());

	/** Current variant label. */
	const currentVariant = $derived(discoveryState.currentVariant);

	/** Display label for the variant badge. */
	const variantLabel = $derived(currentVariant || "default");

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function switchVariant(variant: string) {
		const previousVariant = discoveryState.currentVariant;
		discoveryState.currentVariant = variant;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchVariantRpc({
				projectSlug,
				sessionId,
				variant,
			})
				.then((response) => {
					discoveryState.currentVariant = response.variant;
					variantState.availableVariants = response.variants;
				})
				.catch(() => {
					discoveryState.currentVariant = previousVariant;
				});
		}
	}

	function cycleVariant() {
		// Cycle: default → low → medium → high → max → default
		const cycle = ["", ...variants];
		const currentIdx = cycle.indexOf(currentVariant);
		const nextIdx = (currentIdx + 1) % cycle.length;
		// biome-ignore lint/style/noNonNullAssertion: index is always valid (modulo cycle.length)
		const next = cycle[nextIdx]!;
		switchVariant(next);
	}

	function handleKeydown(e: KeyboardEvent) {
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
		open = false;
	}
</script>

{#if variants.length > 0}
	<Menu
		bind:open
		onopenchange={(nextOpen) => { if (nextOpen) onOpen?.(); }}
		side="top"
		align="end"
		data-testid="variant-dropdown"
	>
		{#snippet trigger({ props })}
			<button
				{...props}
				data-testid="variant-badge"
				class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border border-border bg-bg-alt text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 hover:bg-bg hover:text-text-secondary font-brand"
				title="Thinking level ({variantLabel}) — Ctrl+T to cycle"
			>
				{variantLabel}
				<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
			</button>
		{/snippet}

		<MenuRadioGroup value={currentVariant}>
			<MenuRadioItem
				value=""
				data-testid="variant-option-default"
				onselect={() => switchVariant("")}
			>
				default
			</MenuRadioItem>
			{#each variants as v (v)}
				<MenuRadioItem
					value={v}
					data-testid="variant-option-{v}"
					onselect={() => switchVariant(v)}
				>
					{v}
				</MenuRadioItem>
			{/each}
		</MenuRadioGroup>

		<div class="border-t border-border mt-1 pt-1 px-3 pb-1 text-xs text-text-dimmer">
			Ctrl+T to cycle
		</div>
	</Menu>
{/if}

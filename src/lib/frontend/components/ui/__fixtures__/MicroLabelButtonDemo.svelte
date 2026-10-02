<script lang="ts">
	import type { ComponentProps } from "svelte";
	import EffortMeter from "../EffortMeter.svelte";
	import Icon from "../Icon.svelte";
	// biome-ignore lint/style/useImportType: also rendered in the Svelte template.
	import MicroLabelButton from "../MicroLabelButton.svelte";

	let {
		glyph = "shield",
		levels = 5,
		filled = 0,
		pulseOnTap = false,
		pulseKey,
		onTap,
		...rest
	}: Omit<ComponentProps<typeof MicroLabelButton>, "children"> & {
		glyph?: "shield" | "effort" | "none" | undefined;
		levels?: number | undefined;
		filled?: number | undefined;
		pulseOnTap?: boolean | undefined;
	} = $props();

	let pulse = $state(0);
</script>

{#snippet glyphContent()}
	{#if glyph === "effort"}
		<EffortMeter {levels} {filled} />
	{:else}
		<Icon name="shield-off" size={15} />
	{/if}
{/snippet}

<MicroLabelButton
	{...rest}
	children={glyph === "none" ? undefined : glyphContent}
	pulseKey={pulseOnTap ? pulse : pulseKey}
	onTap={(event) => {
		if (pulseOnTap) pulse += 1;
		onTap?.(event);
	}}
/>

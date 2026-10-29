<script lang="ts">
	import PermissionModeSelector from "../../input/PermissionModeSelector.svelte";
	import GitIdentity from "../../session/GitIdentity.svelte";
	import InstanceModelPicker from "../InstanceModelPicker.svelte";

	let { control = "checkout", presentation = "control", compact = false, variant = "icons" }: {
		control?: "permissions" | "checkout" | undefined;
		presentation?: "word" | "control" | undefined;
		compact?: boolean | undefined;
		variant?: "icons" | "words" | "summary" | undefined;
	} = $props();
</script>

<div class="relative w-full">
	{#if control === "permissions"}
		<PermissionModeSelector {variant} />
	{:else}
		<GitIdentity {presentation} {compact} />
	{/if}
	<div class="picker-host absolute bottom-0 left-0 flex"><InstanceModelPicker /></div>
</div>

<style>
	.picker-host :global([data-testid="model-picker-trigger"]),
	.picker-host :global([data-testid="variant-badge"]) {
		display: none;
	}
</style>

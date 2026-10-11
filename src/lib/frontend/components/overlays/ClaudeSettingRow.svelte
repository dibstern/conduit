<!--
  ClaudeSettingRow — a SettingsRow plus the line saying where its value comes
  from, with Reset when a Conduit override can be removed. `below` holds any
  editor or note that belongs to the setting but is too wide for the row.
  The provenance line sits outside the row so its Reset button is never
  nested inside a switch row's button.
-->
<script lang="ts">
	import type { ComponentProps, Snippet } from "svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import type {
		ClaudeSettingKey,
		ClaudeSettingProvenance,
	} from "../../stores/claude-settings.svelte.js";

	let {
		key,
		provenance,
		onreset,
		below,
		...row
	}: OptionalLabel<ComponentProps<typeof SettingsRow>> & {
		key: ClaudeSettingKey | "defaultModel" | "defaultPermissionMode";
		provenance?: ClaudeSettingProvenance;
		onreset?: () => void;
		below?: Snippet;
	} = $props();
</script>

<script module lang="ts">
	/** Label is optional inside a group whose title already names the setting.
	 * Distributes over SettingsRow's prop union so each variant keeps its shape. */
	type OptionalLabel<P> = P extends unknown
		? Omit<P, "label"> & { label?: string }
		: never;
</script>

<div class="flex flex-col gap-[6px] px-3 py-2" data-testid="claude-setting-{key}">
	{#if row.label}<SettingsRow {...row} label={row.label} class="p-0" />{/if}
	{#if below}
		<div class="flex flex-col gap-[6px]">{@render below()}</div>
	{/if}
	{#if provenance}
		<div
			class="flex items-center justify-between gap-3 text-[11px] text-text-muted"
			data-testid="claude-setting-{key}-provenance"
		>
			<span>
				{provenance.beforeSource ?? ""}{#if provenance.sourceLabel}<span class="text-text-secondary" title={provenance.sourcePath}>{provenance.sourceLabel}</span>{/if}{provenance.afterSource ?? (provenance.sourceLabel ? "" : provenance.text)}
			</span>
			{#if provenance.canReset}
				<TextButton
					class="shrink-0"
					data-testid="claude-setting-{key}-reset"
					onclick={() => void onreset?.()}
				>
					Reset
				</TextButton>
			{/if}
		</div>
	{/if}
</div>

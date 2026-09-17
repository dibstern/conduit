<script lang="ts">
	import type { Snippet } from "svelte";
	import type {
		ClaudeSettingKey,
		ClaudeSettingProvenance,
	} from "../../stores/claude-settings.svelte.js";

	let {
		key,
		label,
		description,
		provenance,
		onreset,
		control,
	}: {
		key: ClaudeSettingKey | "defaultModel" | "defaultPermissionMode";
		label: string;
		description: string;
		provenance?: ClaudeSettingProvenance;
		onreset?: () => void;
		control: Snippet<[string, string]>;
	} = $props();
</script>

<div
	class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand flex flex-col"
	data-testid="claude-setting-{key}"
>
	{@render control(label, description)}
	{#if provenance}
		<div
			class="flex items-center justify-between gap-3 text-xs text-text-dimmer"
			data-testid="claude-setting-{key}-provenance"
		>
			<span>
				{provenance.beforeSource ?? ""}{#if provenance.sourceLabel}<span title={provenance.sourcePath}>{provenance.sourceLabel}</span>{/if}{provenance.afterSource ?? (provenance.sourceLabel ? "" : provenance.text)}
			</span>
			{#if provenance.canReset}
				<button
					type="button"
					class="shrink-0 border-none bg-transparent text-xs text-text-muted hover:text-text cursor-pointer font-brand"
					data-testid="claude-setting-{key}-reset"
					onclick={() => void onreset?.()}
				>
					Reset
				</button>
			{/if}
		</div>
	{/if}
</div>

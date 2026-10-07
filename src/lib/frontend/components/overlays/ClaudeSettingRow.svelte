<script lang="ts">
	import type { Snippet } from "svelte";
	import TextButton from "../ui/TextButton.svelte";
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
	class="flex flex-col gap-[6px] py-[8px] border-b border-border-subtle"
	data-testid="claude-setting-{key}"
>
	{@render control(label, description)}
	{#if provenance}
		<div
			class="flex items-center justify-between gap-3 text-text-dimmer"
			data-testid="claude-setting-{key}-provenance"
		>
			<span>
				{provenance.beforeSource ?? ""}{#if provenance.sourceLabel}<span title={provenance.sourcePath}>{provenance.sourceLabel}</span>{/if}{provenance.afterSource ?? (provenance.sourceLabel ? "" : provenance.text)}
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

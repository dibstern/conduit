<script lang="ts">
	import { onDestroy, type Snippet } from "svelte";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";

	let { label = "code", filename, additions, deletions, code, controls }: {
		label?: string;
		filename?: string | undefined;
		additions?: number | undefined;
		deletions?: number | undefined;
		code: string;
		controls?: Snippet;
	} = $props();
	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyCode() {
		if (!await copyToClipboard(code)) return;
		copied = true;
		clearTimeout(resetTimer);
		resetTimer = setTimeout(() => { copied = false; }, 1500);
	}
	onDestroy(() => clearTimeout(resetTimer));
</script>

<div class="code-block-header flex h-[36px] items-center gap-[10px] border-b border-border-subtle bg-bg-raised px-[12px] font-mono text-mono-xs text-text-secondary">
	{#if filename}<Icon name="file" size={14} class="shrink-0" />{/if}
	<span class="min-w-0 truncate" title={filename}>{filename ?? label}</span>
	{#if additions !== undefined}<span class="shrink-0 text-success">+{additions}</span>{/if}
	{#if deletions !== undefined}<span class="shrink-0 text-error">−{deletions}</span>{/if}
	<div class="ml-auto flex shrink-0 items-center gap-[10px]">
		{@render controls?.()}
		<Button variant="ghost" size="content" tone={copied ? "success" : "muted"} iconOnly icon={copied ? "check" : "copy"} iconSize={14} touchTarget class="code-copy-btn size-[28px] shrink-0" ariaLabel={copied ? "Copied code" : "Copy code"} title={copied ? "Copied!" : "Copy code"} onclick={copyCode} />
	</div>
</div>

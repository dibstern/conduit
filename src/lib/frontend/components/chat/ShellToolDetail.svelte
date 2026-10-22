<script lang="ts">
	import { onDestroy } from "svelte";
	import type { ToolMessage } from "../../types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { shellTokens } from "../../utils/shell-tokens.js";
	import { fmtDuration } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";

	let { tool, command }: { tool: ToolMessage; command: string } = $props();
	let showAll = $state(false);
	let overflowing = $state(false);
	let outputElement = $state<HTMLDivElement>();
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	const tokens = $derived(shellTokens(command));
	const result = $derived.by(() => {
		const text = tool.result ?? "";
		const note = /(?:^|\r?\n)(Shell cwd was reset to .+?)(?:\r?\n)?$/.exec(text);
		return { output: note ? text.slice(0, note.index) : text, cwd: note?.[1] };
	});
	const exitCode = $derived(tool.metadata?.['movedToBackground'] !== true && typeof tool.metadata?.['exitCode'] === "number" ? tool.metadata['exitCode'] : undefined);
	const duration = $derived(tool.createdAt !== undefined && tool.endedAt !== undefined
		? Math.max(0, tool.endedAt - tool.createdAt) : undefined);

	$effect(() => {
		const element = outputElement;
		void result.output;
		if (!element) return;
		const measure = () => { overflowing = element.scrollHeight > element.clientHeight + 1; };
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});

	async function copyCommand() {
		if (!await copyToClipboard(command)) return;
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => { copied = false; }, 3000);
	}
	onDestroy(() => clearTimeout(copyTimer));
</script>

<div class="shell-detail my-[4px] font-mono text-mono-xs">
	<div class="shell-command"><span>{#each tokens as token}<span class="shell-token {token.kind}">{token.text}</span>{/each}</span><Button variant="ghost" size="content" tone="muted" hoverFill="text" iconOnly icon={copied ? "check" : "copy"} iconSize={14} ariaLabel={copied ? "Copied!" : "Copy command"} title={copied ? "Copied!" : "Copy command"} class="absolute top-[8px] right-[8px] size-[24px] rounded-[6px]" onclick={copyCommand} /></div>
	{#if result.output}
		<div class="shell-output-zone">
			<div class="shell-output" class:clipped={!showAll} class:faded={!showAll && overflowing} class:text-error={tool.isError || tool.status === "error"} bind:this={outputElement}>{result.output}</div>
			{#if overflowing && !showAll}<Button variant="ghost" size="content" tone="accent" hoverFill="none" class="mt-[4px] text-[12px] font-sans font-medium" onclick={() => { showAll = true; }}>Show all output</Button>{/if}
		</div>
	{/if}
	{#if exitCode !== undefined || duration !== undefined || result.cwd}
		<div class="shell-footer">
			{#if exitCode !== undefined}<span data-testid="tool-exit-code" class={exitCode === 0 ? "text-success" : "text-error"}>{exitCode === 0 ? "✓" : "✗"} exit {exitCode}</span>{/if}
			{#if exitCode !== undefined && duration !== undefined}<span>·</span>{/if}
			{#if duration !== undefined}<span>{fmtDuration(duration)}</span>{/if}
			{#if result.cwd}<span class="ml-auto" title={result.cwd}>cwd reset</span>{/if}
		</div>
	{/if}
</div>

<style>
	.shell-detail { border:1px solid var(--color-border); border-radius:10px; overflow:hidden; line-height:1.6; }
	.shell-command { position:relative; padding:10px 36px 10px 12px; background:var(--color-bg-alt); color:var(--color-text); white-space:pre-wrap; overflow-wrap:anywhere; }
	.shell-output-zone { padding:10px 12px; background:var(--color-code-bg); }
	.shell-output { position:relative; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--color-text-secondary); }
	.shell-output.text-error { color:var(--color-error); }
	.shell-output.clipped { max-height:9.6em; overflow:hidden; }
	.shell-output.faded::after { content:""; position:absolute; inset:auto 0 0; height:2.4em; background:linear-gradient(transparent,var(--color-code-bg)); pointer-events:none; }
	.shell-footer { display:flex; gap:8px; align-items:center; padding:6px 12px; border-top:1px solid var(--color-border-subtle); background:var(--color-code-bg); color:var(--color-text-dimmer); font:11px var(--font-sans); }
	.command { color:var(--hl-function); font-weight:500; }
	.flag { color:var(--hl-builtin); }
	.string { color:var(--hl-string); }
	.variable { color:var(--hl-variable); }
	.operator { color:var(--hl-keyword); }
	.heredoc { color:var(--hl-meta); }
	.comment { color:var(--hl-comment); font-style:italic; }
</style>

<!-- An expanded tool, in full. The transcript carries long inputs and outputs as -->
<!-- previews; when the card shows a cut one, it loads the rest through the       -->
<!-- tool-detail module, and a failed load says so with a retry rather than       -->
<!-- passing the preview off as the whole.                                        -->
<script lang="ts">
	import { type Snippet, untrack } from "svelte";
	import type { ToolDetail } from "../../../contracts/tool-wire.js";
	import type { ToolMessage } from "../../types.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { type SessionRef, shownCut, toolDetails } from "../../stores/tool-details.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { renderMarkdown } from "../../utils/markdown.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import Button from "../ui/Button.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";

	const loadFromServer = async (tool: ToolMessage, session: SessionRef | undefined) =>
		session && (await toolDetails.get(session, tool));

	let {
		message,
		load = loadFromServer,
		children,
		showExitCode = true,
		class: className = "",
	}: {
		message: ToolMessage;
		load?: (
			tool: ToolMessage,
			session: SessionRef | undefined,
		) => Promise<ToolDetail | undefined>;
		children: Snippet<[ToolMessage]>;
		showExitCode?: boolean;
		class?: string;
	} = $props();

	let full = $state<ToolMessage>();
	let failed = $state(false);
	let failure = $state<unknown>();
	let attempt = $state(0);

	const cut = $derived(shownCut(message));
	const hasPresentation = $derived(message.presentation !== undefined);
	const presentation = $derived(message.presentation);
	const shown = $derived.by(() => {
		const tool = full ?? message;
		const output = message.metadata?.['output'];
		return typeof output === "string" && tool.result === undefined && tool.status !== "error"
			? { ...tool, result: output }
			: tool;
	});
	const input = $derived(hasPresentation ? ensureCanonical(shown.name, shown.input) : undefined);

	// The session the tool is shown in: a fork repeats its parent's call ids.
	const session = $derived.by((): SessionRef | undefined => {
		const projectSlug = getCurrentSlug();
		const sessionId = getCurrentSessionId();
		return projectSlug && sessionId ? { projectSlug, sessionId } : undefined;
	});

	// Load again when the tool moves on, not each time the same state is re-sent.
	const loadKey = $derived(
		cut
			? `${session?.projectSlug}\0${session?.sessionId}\0${message.id}:${message.status}${hasPresentation ? `:${message.result === undefined}` : ""}`
			: undefined,
	);

	$effect(() => {
		void attempt;
		const key = loadKey;
		full = undefined;
		failed = false;
		failure = undefined;
		if (key === undefined) return;
		const [tool, ref] = untrack(() => [message, session] as const);
		let current = true;
		const fail = (error?: unknown) => {
			if (current) {
				failed = true;
				failure = error;
			}
		};
		load(tool, ref).then((detail) => {
			if (!current) return;
			if (!detail) return fail();
			const { preview: _preview, ...whole } = tool;
			full = {
				...whole,
				...(detail.input && { input: detail.input.value }),
				...(detail.output && !tool.isError && { result: detail.output.text }),
				...(detail.fileChanges !== undefined && { fileChanges: detail.fileChanges }),
			};
		}, fail);
		return () => {
			current = false;
		};
	});
</script>

<div class={className}>
{#if shown.fileChanges?.length}
	{#each shown.fileChanges as change}
	{@const patchLines = change.patch?.split("\n")}
	<div data-testid="tool-file-change" class="my-1 overflow-x-auto">
		<div class="font-mono text-xs text-text-secondary">{#if change.kind === "move"}{change.oldPath} → {/if}{change.path} <span class="text-text-muted">{change.kind}</span></div>
		<div class="diff-stats flex gap-3 text-xs">
			{#if patchLines}<span class="text-success">+{patchLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length}</span><span class="text-error">-{patchLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}</span>{/if}
		</div>
		{#if change.patch !== undefined}<pre class="tool-result font-mono text-xs whitespace-pre-wrap">{#each change.patch.split("\n") as line}<span class={line.startsWith("+") ? "text-success" : line.startsWith("-") ? "text-error" : "text-text-secondary"}>{line}{"\n"}</span>{/each}</pre>{:else}
			{#if change.before !== undefined}<pre class="tool-result font-mono text-xs whitespace-pre-wrap text-error" aria-label="Before">{change.before}</pre>{/if}
			{#if change.after !== undefined}<pre class="tool-result font-mono text-xs whitespace-pre-wrap text-success" aria-label="After">{change.after}</pre>{/if}
		{/if}
	</div>
	{/each}
{:else if presentation?.plan}
	<section data-testid="tool-plan" class="my-1">
		{#if presentation.plan.title}<h3 class="text-sm font-medium">{presentation.plan.title}</h3>{/if}
		<div class="md-content text-xs">{@html renderMarkdown(presentation.plan.content)}</div>
	</section>
{:else}
	{@render children(shown)}
{/if}
{#if presentation?.computerUse}
	<ol data-testid="tool-computer-actions" class="my-1 list-decimal list-inside font-mono text-mono-xs text-text-secondary">
		{#each presentation.computerUse.actions as action}
			<li>{JSON.stringify(action)}</li>
		{/each}
	</ol>
{/if}
{#each presentation?.media ?? [] as media}
	<div data-testid="tool-media" class="my-1">
		{#if media.url?.startsWith("data:image/") && media.mime.startsWith("image/")}
			<img src={media.url} alt={presentation?.computerUse ? "Computer screenshot" : media.path ?? "Generated image"} class="max-w-full rounded" />
		{:else if media.url?.startsWith("data:video/") && media.mime.startsWith("video/")}
			<video src={media.url} controls aria-label="Screen recording" class="max-w-full rounded"><track kind="captions" /></video>
		{:else if media.path}
			<span class="font-mono text-xs text-text-muted">{media.path}</span>
		{/if}
	</div>
{/each}
{#if presentation?.movedToBackground}
	<div data-testid="tool-moved-to-background" class="text-xs text-text-muted">Moved to background. The command may still be running.</div>
{:else if showExitCode && presentation?.exitCode !== undefined}
	<div data-testid="tool-exit-code" class="text-xs text-text-muted">Exit code {presentation.exitCode}</div>
{/if}
{#if presentation?.truncated}
	<div data-testid="tool-truncated" class="text-xs text-text-muted">Output truncated</div>
{/if}
{#if input?.tool === "Unknown"}
	<details class="my-1 text-xs text-text-muted">
		<summary class="cursor-pointer">Arguments</summary>
		<pre class="font-mono whitespace-pre-wrap break-all">{JSON.stringify(input.raw, null, 2)}</pre>
	</details>
{/if}
{#if cut && !full}
	<div class="tool-full-detail flex items-center gap-2 text-xs text-text-dimmer">
		{#if failed}
			<span>{failureLine(failure, `Couldn't load the full ${cut}.`)}</span>
			<Button
				variant="accent-soft"
				size="content"
				class="px-2 py-0.5 rounded text-xs font-medium"
				onclick={() => attempt++}
			>
				Retry
			</Button>
		{:else}
			<ConduitMark size={16} variant="running" />
			<span>Loading full {cut}…</span>
		{/if}
	</div>
{/if}
</div>

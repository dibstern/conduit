<!-- ─── Tool Group Item ──────────────────────────────────────────────────────── -->
<!-- Compact row within a ToolGroupCard. Shows tree connector, tool name, -->
<!-- subtitle, tags, and status dot. Clickable to inline-expand the result. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { applyToolContentResponse } from "../../stores/ws-dispatch.js";
	import { getToolContentRpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import Surface from "../ui/Surface.svelte";

	let { message, isLast = false }: {
		message: ToolMessage;
		isLast?: boolean | undefined;
	} = $props();
	let expanded = $state(false);
	let loadingFullContent = $state(false);

	const summary = $derived(
		lookupSummarizer(message.name).summarize(
			ensureCanonical(message.name, message.input),
			{},
		),
	);

	// For Bash/Shell tools, extract the raw command for display in expanded view
	const bashCommand = $derived.by(() => {
		if (message.name !== "Bash") return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		const cmd = inp["command"];
		return typeof cmd === "string" ? cmd : null;
	});

	function formatKB(length: number): string {
		return `${(length / 1024).toFixed(1)} KB`;
	}

	function handleToggle() {
		expanded = !expanded;
	}

	let loadingTimeout: ReturnType<typeof setTimeout> | undefined;

	function requestFullContent() {
		const slug = getCurrentSlug();
		if (!slug) return;
		loadingFullContent = true;
		clearTimeout(loadingTimeout);
		loadingTimeout = setTimeout(() => {
			loadingFullContent = false;
		}, TOOL_CONTENT_LOAD_TIMEOUT_MS);
		void getToolContentRpc({ projectSlug: slug, toolId: message.id })
			.then((response) => {
				applyToolContentResponse(response);
				loadingFullContent = false;
				clearTimeout(loadingTimeout);
			})
			.catch(() => {
				loadingFullContent = false;
				clearTimeout(loadingTimeout);
			});
	}

	$effect(() => {
		if (!message.isTruncated) {
			loadingFullContent = false;
			clearTimeout(loadingTimeout);
		}
	});

	// Error styling for result (Tailwind classes with / can't use class: directive)
	const resultErrorClass = $derived(
		message.isError ? "border-error/30 text-error" : "",
	);
</script>

<div class="tool-group-item" data-tool-id={message.id}>
	<!-- Compact row -->
	<Disclosure {expanded} onToggle={handleToggle} chevron={false} density="compact">
		<!-- Tree connector -->
		<span class="font-mono text-border text-xs shrink-0 w-3 text-center">
			{isLast ? "└" : "├"}
		</span>

		<!-- Tool name -->
		<span class="text-text-dimmer font-medium shrink-0">
			{message.name}
		</span>

		<!-- Subtitle -->
		{#if summary.subtitle}
			<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-dimmer">
				{summary.subtitle}
			</span>
		{:else}
			<span class="flex-1"></span>
		{/if}

		<!-- Tags -->
		{#if summary.tags}
			{#each summary.tags as tag}
				<Badge variant="tag" size="sm" class="font-mono select-text">{tag}</Badge>
			{/each}
		{/if}


	</Disclosure>

	<!-- Expanded result -->
	{#if expanded && (message.result || bashCommand)}
		<div class="ml-8 mr-2.5">
			<!-- padding stays in `class`: px-2.5 py-2 is off Surface's scale, and
			     `padding="none"` means Surface emits none of its own to collide
			     with it. Convergence is conduit-test-8rag. -->
			<Surface
				variant="inset"
				radius="md"
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 py-2 px-2.5 text-text-secondary max-h-[300px] overflow-y-auto {resultErrorClass}"
			>
				{#if bashCommand}<span class="text-text-muted">$ {bashCommand}</span>{#if message.result}{"\n\n"}{/if}{/if}{#if message.result}{message.result}{/if}
			</Surface>

			{#if message.isTruncated && message.result}
				<div class="flex items-center gap-2 mt-1 mb-1 text-xs text-text-dimmer">
					<span class="font-mono">
						Showing {formatKB(message.result.length)} of {formatKB(message.fullContentLength ?? message.result.length)}
					</span>
					<Button
						variant="accent-soft"
						size="content"
						class="px-2 py-0.5 rounded text-xs font-medium"
						onclick={requestFullContent}
						disabled={loadingFullContent}
					>
						{#if loadingFullContent}
							Loading…
						{:else}
							Show full output
						{/if}
					</Button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- An expanded tool, in full. The transcript carries long inputs and outputs as -->
<!-- previews; showing one loads the rest through GetToolDetails, and a failed    -->
<!-- load says so with a retry rather than passing the preview off as the whole.  -->
<script lang="ts">
	import { type Snippet, untrack } from "svelte";
	import { ToolCallId, type ToolDetail } from "../../../contracts/tool-wire.js";
	import type { ToolMessage } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getToolDetailsRpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";

	async function loadFromServer(toolId: string): Promise<ToolDetail | undefined> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return undefined;
		const { tools } = await getToolDetailsRpc({ projectSlug, toolIds: [ToolCallId.make(toolId)] });
		return tools[0];
	}

	let {
		message,
		load = loadFromServer,
		children,
		class: className = "",
	}: {
		message: ToolMessage;
		load?: (toolId: string) => Promise<ToolDetail | undefined>;
		children: Snippet<[ToolMessage]>;
		class?: string;
	} = $props();

	let full = $state<ToolMessage>();
	let failed = $state(false);
	let attempt = $state(0);

	// Load again when the tool moves on, not each time the same state is re-sent.
	const loadKey = $derived(message.preview ? `${message.id}:${message.status}` : undefined);

	$effect(() => {
		void attempt;
		const key = loadKey;
		full = undefined;
		failed = false;
		if (key === undefined) return;
		const tool = untrack(() => message);
		let current = true;
		const fail = () => {
			if (current) failed = true;
		};
		// A load that never settles must still end in the retry.
		const timeout = setTimeout(fail, TOOL_CONTENT_LOAD_TIMEOUT_MS);
		load(tool.id).then((detail) => {
			if (!current) return;
			if (!detail) return fail();
			const { preview: _preview, ...whole } = tool;
			full = {
				...whole,
				...(detail.input && { input: detail.input.value }),
				...(detail.output && !tool.isError && { result: detail.output.text }),
			};
		}, fail).finally(() => clearTimeout(timeout));
		return () => {
			current = false;
			clearTimeout(timeout);
		};
	});
</script>

{@render children(full ?? message)}
{#if message.preview && !full}
	<div class="tool-full-detail flex items-center gap-2 text-xs text-text-dimmer {className}">
		{#if failed}
			<span>Couldn't load the full output.</span>
			<Button
				variant="accent-soft"
				size="content"
				class="px-2 py-0.5 rounded text-xs font-medium"
				onclick={() => attempt++}
			>
				Retry
			</Button>
		{:else}
			<span>Loading full output…</span>
		{/if}
	</div>
{/if}

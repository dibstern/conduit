<!-- The inputs conduit holds for this session, oldest first, exactly as the
     session-detail stream reports them. The browser keeps no queue of its own:
     a row appears when the server admits a send and leaves when the adapter
     places it in the transcript or someone removes it. Hidden when there are
     none. Remove, Edit and Resume are server commands; their effect comes back
     through the stream, on every client. -->
<script lang="ts">
	import type { PendingInput } from "../../stores/chat.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { cancelInputRpc, sendInputNowRpc } from "../../transport/ws-rpc-client.js";
	import { extractDisplayText } from "../../utils/format.js";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import TextButton from "../ui/TextButton.svelte";

	let {
		inputs,
		paused = false,
		onEdit,
	}: {
		inputs: readonly PendingInput[];
		/** The last turn was stopped or failed, so nothing drains until Resume. */
		paused?: boolean;
		/** Takes back a queued input that Edit removed. */
		onEdit: (text: string, images: readonly string[]) => void;
	} = $props();

	/** True when the server applied the command; a row that started is refused. */
	async function act(
		rpc: typeof cancelInputRpc,
		input: PendingInput,
	): Promise<boolean> {
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (!projectSlug || !sessionId) return false;
		try {
			const response = await rpc({ projectSlug, sessionId, inputId: input.inputId });
			if (response.ok) return true;
			showToast("That message already started", { variant: "warn" });
		} catch {
			showToast("Could not update the queue", { variant: "error" });
		}
		return false;
	}

	async function edit(input: PendingInput) {
		if (await act(cancelInputRpc, input))
			onEdit(extractDisplayText(input.request.text), input.request.images ?? []);
	}
</script>

{#if inputs.length > 0}
	<div
		data-testid="pending-input-tray"
		class="flex flex-col gap-1 mb-2 rounded-2xl border border-border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary"
	>
		{#if paused}
			<div data-testid="pending-input-paused" class="flex items-center gap-2">
				<span class="flex-1 min-w-0 font-semibold text-status-amber">Paused</span>
				<TextButton
					tone="accent"
					data-testid="pending-input-resume"
					class="shrink-0 font-semibold"
					onclick={() => act(sendInputNowRpc, inputs[0]!)}
				>Resume</TextButton>
			</div>
		{/if}
		<ol aria-label="Queued messages" class="flex flex-col gap-1">
			{#each inputs as input (input.inputId)}
				{@const images = input.request.images?.length ?? 0}
				<li data-testid="pending-input-row" data-input-id={input.inputId} class="flex items-center gap-2">
					<span data-testid="pending-input-text" class="flex-1 min-w-0 truncate">{extractDisplayText(input.request.text)}</span>
					{#if images > 0}
						<span
							data-testid="pending-input-images"
							aria-label={images === 1 ? "1 image" : `${images} images`}
							class="flex items-center gap-1 shrink-0 text-text-muted"
						><Icon name="image" size={12} />{images}</span>
					{/if}
					<Badge variant="quiet" shape="pill" data-testid="pending-input-state">{input.state === "steering" ? "Steering" : "Queued"}</Badge>
					{#if input.state === "queued"}
						<TextButton data-testid="pending-input-edit" class="shrink-0" onclick={() => edit(input)}>Edit</TextButton>
						<TextButton data-testid="pending-input-remove" class="shrink-0" onclick={() => act(cancelInputRpc, input)}>Remove</TextButton>
					{/if}
				</li>
			{/each}
		</ol>
	</div>
{/if}

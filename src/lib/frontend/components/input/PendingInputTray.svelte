<!-- The inputs conduit holds for this session, oldest first, exactly as the
     session-detail stream reports them. The browser keeps no queue of its own:
     a row appears when the server admits a send and leaves when the adapter
     places it in the transcript. Hidden when there are none. -->
<script lang="ts">
	import type { PendingInput } from "../../stores/chat.svelte.js";
	import { extractDisplayText } from "../../utils/format.js";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";

	let { inputs }: { inputs: readonly PendingInput[] } = $props();
</script>

{#if inputs.length > 0}
	<ol
		data-testid="pending-input-tray"
		aria-label="Queued messages"
		class="flex flex-col gap-1 mb-2 rounded-2xl border border-border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary"
	>
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
			</li>
		{/each}
	</ol>
{/if}

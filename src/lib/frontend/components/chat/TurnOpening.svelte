<script lang="ts">
	import type { Turn } from "../../utils/turns.js";
	import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";

	let { opening, turn, sessionId }: {
		opening: NonNullable<Turn["opening"]>;
		turn?: Turn;
		sessionId?: string | undefined;
	} = $props();
	// The summary chip makes the card head 24px on wider screens; otherwise
	// its 14px label sets a 21px row. Match both without drawing the card.
	const summaryHead = $derived(!!sessionId && !!(turn?.storeId ?? turn?.user?.messageId) && messageSurfacing.status.summariesEnabled && messageSurfacing.status.recap.model !== "off");
</script>

<!-- Reserve the activity header's 28px and the card head's 10px top inset. -->
<div role="status" data-testid="turn-opening" class="max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px] pt-[38px] pb-[2px] md:pb-[9px]">
	<div class="md:ml-[42px] px-[12px]">
		<div data-testid="turn-opening-row" class="flex h-[21px] items-center gap-[6px] text-[14px] text-text-dimmer {summaryHead ? 'min-[600px]:h-[24px]' : ''}">
			<span data-testid="turn-opening-pulse" aria-hidden="true" class="size-[6px] mx-[3.5px] shrink-0 rounded-full bg-current motion-safe:animate-pulse"></span>
			<span>{opening === "sending" ? "Sending…" : "Working"}</span>
		</div>
	</div>
</div>

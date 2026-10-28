<script lang="ts">
	import type { Turn } from "../../utils/turns.js";
	import AssistantHeader from "./AssistantHeader.svelte";

	let { opening, providerId }: {
		opening: NonNullable<Turn["opening"]>;
		providerId?: string | undefined;
	} = $props();
</script>

<!-- Same box as TurnActivity's header row, so the first step's card grows
     below it without moving anything above. -->
<div role="status" data-testid="turn-opening" class="max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px]">
	<AssistantHeader {providerId} pending={opening === "sending" ? "Sending…" : "Working"} />
</div>

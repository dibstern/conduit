<script lang="ts">
	import type { CompactionPart, Turn } from "../../utils/turns.js";
	import AssistantHeader from "./AssistantHeader.svelte";
	import CompactionRule from "./CompactionRule.svelte";

	let { opening, part, providerId }: {
		opening?: NonNullable<Turn["opening"]>;
		part?: CompactionPart;
		providerId?: string | undefined;
	} = $props();
</script>

<!-- Same box as TurnActivity's header row, so the first step's card grows
     below it without moving anything above. Settled preface rules keep this box. -->
<div role={opening ? "status" : undefined} data-testid={opening ? "turn-opening" : "turn-preface"} class="max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px]">
	{#if part || opening === "compacting"}
		<CompactionRule {part} />
	{:else}
		<AssistantHeader {providerId} pending={opening === "sending" ? "Sending…" : "Working"} />
	{/if}
</div>

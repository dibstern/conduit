<script lang="ts">
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { sessionMatchesStatus } from "../../stores/session.svelte.js";
	import { getSessionGrouping, getSessionStatusFilter, setSessionGrouping, setSessionStatusFilter, type SessionStatusFilter } from "../../stores/session-scope.js";
	import type { SessionInfo } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import SessionSearchField from "./SessionSearchField.svelte";
	import SessionGroupMenu from "./SessionGroupMenu.svelte";

	let { localSearchValue, live, searchSummary, onsearchinput, onclearsearch, onaddproject }: {
		localSearchValue: string;
		live: SessionInfo[];
		searchSummary: string | null;
		onsearchinput: (text: string) => void;
		onclearsearch: () => void;
		onaddproject?: (() => void) | undefined;
	} = $props();
	const grouping = $derived(getSessionGrouping());
	const statusFilter = $derived(getSessionStatusFilter());
	const filterChips: { value: SessionStatusFilter; label: string }[] = [
		{ value: "needs-you", label: "Needs you" },
		{ value: "running", label: "Running" },
		{ value: "unread", label: "Unread" },
	];

	// Literal px: the 12px root would shrink rem steps below the design's sizes.
	// touchTarget restores a 44px hit area on phones without growing the chip.
	const CHIP_CLASSES =
		"shrink-0 gap-[6px] rounded-full border px-[11px] py-[8px] md:px-[9px] md:py-[5px] text-[12.5px] md:text-[11.5px] leading-none font-brand";

	function filterSurfaceClass(needsAttention: boolean, active: boolean): string {
		if (needsAttention) return "border-accent/55 bg-accent/14 text-status-pink";
		if (active) return "border-border-chip bg-bg-alt text-text";
		return "border-border text-text-secondary";
	}
</script>

	<div id="session-search" class="shrink-0 px-[12px] md:px-[10px] pt-[4px]">
		<SessionSearchField
			value={localSearchValue}
			oninput={onsearchinput}
			onescape={onclearsearch}
			{onaddproject}
		/>
	</div>
	<div class="flex shrink-0 items-center gap-1 px-[12px] md:px-[10px]">
			<!-- Vertical padding lives here, not on the row: it is the room the
			     chips' 44px hit areas need inside this scroll container. -->
			<div class="flex min-w-0 flex-1 items-center gap-[6px] pt-[9px] pb-[7px] md:pt-[8px] md:pb-[4px] overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{#if grouping !== "status"}
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						touchTarget
						class="{CHIP_CLASSES} {filterSurfaceClass(false, true)}"
						data-testid="session-group-chip"
						onclick={() => setSessionGrouping("status")}
					>
						By {grouping} <span aria-hidden="true" class="text-text-dimmer">✕</span>
					</Button>
				{/if}
				{#each filterChips as chip (chip.value)}
					{@const active = statusFilter === chip.value}
					{@const count = live.filter((session) => sessionMatchesStatus(session, chip.value)).length}
					{@const needsAttention = chip.value === "needs-you" && count > 0}
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						touchTarget
						class="{CHIP_CLASSES} {filterSurfaceClass(needsAttention, active)}"
						aria-pressed={active}
						data-testid={`session-filter-chip-${chip.value}`}
						onclick={() => setSessionStatusFilter(active ? null : chip.value)}
					>
						{chip.label} <b class="font-semibold text-text">{count}</b>
						{#if active}<span aria-hidden="true" class="text-text-dimmer">✕</span>{/if}
					</Button>
				{/each}
			</div>
			{#if !sessionViewState.compact}<SessionGroupMenu />{/if}
	</div>
	{#if searchSummary}
		<!-- Outside the search-input block: the count belongs to the results, and
		     the input's visibility is local component state. -->
		<div
			class="flex shrink-0 items-center justify-between gap-2 px-3.5 pb-1.5 text-xs text-text-dimmer font-brand"
			data-testid="session-search-summary"
		>
			<span aria-live="polite">{searchSummary}</span>
			<TextButton onclick={onclearsearch}>Clear</TextButton>
		</div>
	{/if}

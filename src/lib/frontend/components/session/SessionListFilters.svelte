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
</script>

	<div id="session-search" class="shrink-0 px-2.5 py-1 pb-1.5">
		<SessionSearchField
			value={localSearchValue}
			oninput={onsearchinput}
			onescape={onclearsearch}
			{onaddproject}
		/>
	</div>
	<div class="flex shrink-0 items-center gap-1 px-2.5 pb-1.5">
			<div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{#if grouping !== "status"}
					<Button
						variant="ghost"
						size="content"
						tone="default"
						class="shrink-0 gap-1.5 rounded-full border border-border bg-bg-alt px-2.5 text-xs font-brand {sessionViewState.compact ? 'min-h-[44px]' : 'min-h-8'}"
						data-testid="session-group-chip"
						onclick={() => setSessionGrouping("status")}
					>
						By {grouping} <span aria-hidden="true" class="text-text-dimmer">✕</span>
					</Button>
				{/if}
				{#each filterChips as chip (chip.value)}
					{@const active = statusFilter === chip.value}
					{@const count = live.filter((session) => sessionMatchesStatus(session, chip.value)).length}
					<Button
						variant="ghost"
						size="content"
						tone={chip.value === "needs-you" && count > 0 ? "accent" : active ? "default" : "secondary"}
						class="shrink-0 gap-1.5 rounded-full border px-2.5 text-xs font-brand {sessionViewState.compact ? 'min-h-[44px]' : 'min-h-8'} {chip.value === 'needs-you' && count > 0 ? 'border-accent/40 bg-accent/10' : active ? 'border-border bg-bg-alt' : 'border-border-subtle'}"
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

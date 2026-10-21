<script lang="ts">
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { sessionMatchesStatus, sessionState, setSearchIncludeArchived } from "../../stores/session.svelte.js";
	import { getSessionGrouping, getSessionStatusFilter, setSessionGrouping, setSessionStatusFilter, type SessionStatusFilter } from "../../stores/session-scope.js";
	import type { SessionInfo } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
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

	<div id="session-search" class="shrink-0 px-[10px] md:pb-[8px]">
		<SessionSearchField
			value={localSearchValue}
			oninput={onsearchinput}
			onescape={onclearsearch}
			{onaddproject}
		/>
	</div>
	<div class="flex shrink-0 items-center gap-[5px] px-[10px] pb-[4px]">
			<!-- Vertical padding lives here, not on the row: it is the room the
			     chips' 44px hit areas need inside this scroll container. -->
			<div class="flex min-w-0 flex-1 items-center gap-[5px] py-[10px] md:py-0 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{#if grouping !== "status"}
					<Button
						variant="filter"
						size="content"
						touchTarget
						aria-pressed="true"
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
						variant="filter"
						size="content"
						touchTarget

						aria-pressed={active}
						data-testid={`session-filter-chip-${chip.value}`}
						onclick={() => setSessionStatusFilter(active ? null : chip.value)}
					>
						{chip.label} <span class="font-mono text-[11px] font-normal {active ? 'text-status-ask' : 'text-text-dimmer'}">{count}</span>
					</Button>
				{/each}
			</div>
			<SessionGroupMenu compact={sessionViewState.compact} />
	</div>
	{#if sessionState.searchQuery.trim()}
		<!-- Outside the search-input block: the count belongs to the results, and
		     the input's visibility is local component state. -->
		<div
			class="flex shrink-0 items-center justify-between gap-2 px-3.5 pb-1.5 text-xs text-text-dimmer font-sans"
			data-testid="session-search-summary"
		>
			<span aria-live="polite">{searchSummary ?? "Searching…"}</span>
			<label class="flex items-center gap-1.5 whitespace-nowrap">
				<Checkbox
					data-testid="search-include-archived"
					checked={sessionState.searchIncludeArchived}
					onchange={(event) => void setSearchIncludeArchived(event.currentTarget.checked)}
				/>
				Include archived
			</label>
			<TextButton onclick={onclearsearch}>Clear</TextButton>
		</div>
	{/if}

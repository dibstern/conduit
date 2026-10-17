<script lang="ts">
	import { onMount, tick } from "svelte";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";

	type SearchRpc = typeof rpc<"ListDaemonSessions">;
	type SearchResponse = Awaited<ReturnType<SearchRpc>>;
	type SearchResult = SearchResponse["sessions"][number];

	// The story supplies a transport stub; the app uses the daemon RPC directly.
	let { search = rpc, initiallyOpen = false }: { search?: SearchRpc; initiallyOpen?: boolean } = $props();
	onMount(() => { if (initiallyOpen) openSearch(); });

	let open = $state(false);
	let query = $state("");
	let includeArchived = $state(false);
	let activeQuery = "";
	let results = $state<SearchResult[]>([]);
	let cursor = $state<SearchResponse["nextCursor"]>(null);
	let hasMore = $state(false);
	let loading = $state(false);
	let failed = $state<string | null>(null);
	let highlighted = $state(-1);
	let input: HTMLInputElement | undefined = $state();
	let opener: HTMLElement | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let requestToken = 0;

	const announcement = $derived(
		failed
			? failed
			: loading && results.length === 0
			? ""
			: results.length === 0
				? "No results"
				: `${results.length}${hasMore ? "+" : ""} results`,
	);

	function projectName(slug: string): string {
		return projectState.projects.find((project) => project.slug === slug)?.title || slug;
	}

	function projectAccent(slug: string): number {
		const index = projectState.projects.findIndex((project) => project.slug === slug);
		return (Math.max(index, 0) % 6) + 1;
	}

	function shelf(result: SearchResult): string {
		if (result.pinnedAt != null) return "Pinned";
		if (result.settledAt != null) return "Settled";
		if (result.snoozedAt != null && (result.snoozedUntil == null || result.snoozedUntil > Date.now())) return "Snoozed";
		return "";
	}

	function close(): void {
		open = false;
		includeArchived = false;
		requestToken++;
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
	}

	function openSearch(): void {
		if (open) {
			input?.focus();
			return;
		}
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		open = true;
		query = "";
		results = [];
		highlighted = -1;
		void fetchPage("", true);
		void tick().then(() => input?.focus());
	}

	function handleShortcut(event: KeyboardEvent): void {
		if (event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
		event.preventDefault();
		openSearch();
	}

	function handleInput(event: Event): void {
		query = (event.currentTarget as HTMLInputElement).value;
		requestToken++;
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		// Keep the previous results on screen until the new page lands, so each
		// keystroke does not flash the list empty.
		cursor = null;
		hasMore = false;
		failed = null;
		highlighted = -1;
		loading = true;
		const trimmed = query.trim();
		if (!trimmed) includeArchived = false;
		debounceTimer = setTimeout(() => void fetchPage(trimmed, true), trimmed ? 150 : 0);
	}

	function toggleIncludeArchived(event: Event): void {
		includeArchived = (event.currentTarget as HTMLInputElement).checked;
		if (!includeArchived) results = results.filter((result) => result.archivedAt == null);
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		cursor = null;
		hasMore = false;
		highlighted = -1;
		void fetchPage(query.trim(), true);
	}

	async function fetchPage(searchQuery: string, replace: boolean): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) {
			loading = false;
			failed = "Search unavailable";
			return;
		}
		const token = replace ? ++requestToken : requestToken;
		if (replace) activeQuery = searchQuery;
		loading = true;
		failed = null;
		try {
			const response = await search("ListDaemonSessions", {
				projectSlug,
				roots: true,
				limit: searchQuery ? 20 : 8,
				...(searchQuery ? { search: searchQuery } : {}),
				...(includeArchived ? { includeArchived: true } : {}),
				...(!replace && cursor ? { cursor } : {}),
			});
			if (token !== requestToken || !open) return;
			if (replace) {
				results = [...response.sessions];
			} else {
				const seen = new Set(results.map((row) => row.id));
				results = [...results, ...response.sessions.filter((row) => !seen.has(row.id))];
			}
			cursor = searchQuery ? response.nextCursor : null;
			hasMore = searchQuery ? response.hasMore : false;
		} catch (error) {
			if (token === requestToken && open) failed = failureLine(error, "Search unavailable");
		} finally {
			if (token === requestToken && open) loading = false;
		}
	}

	function showMore(): void {
		if (loading || !hasMore || cursor === null) return;
		void fetchPage(activeQuery, false);
	}

	function choose(result: SearchResult): void {
		close();
		// Viewing a shelf session needs no unsnooze or
		// unsettle mutation, so preserve its shelf state when navigating.
		selection.open(result.id);
	}

	function handleInputKeydown(event: KeyboardEvent): void {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (results.length === 0) return;
			highlighted = event.key === "ArrowDown"
				? (highlighted + 1) % results.length
				: highlighted < 0 ? results.length - 1 : (highlighted - 1 + results.length) % results.length;
		} else if (event.key === "Enter" && highlighted >= 0) {
			event.preventDefault();
			const result = results[highlighted];
			if (result) choose(result);
		}
	}
</script>

<svelte:window onkeydown={handleShortcut} />

{#snippet body()}
	<div data-testid="deep-search" class="flex flex-col gap-3 font-brand">
		<TextInput
			bind:element={input}
			size="content"
			chrome="bare"
			data-testid="deep-search-input"
			role="combobox"
			aria-label="Search every session"
			aria-autocomplete="list"
			aria-expanded="true"
			aria-controls="deep-search-results"
			aria-activedescendant={highlighted >= 0 ? `deep-search-option-${highlighted}` : undefined}
			class="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-base text-text focus:border-border-chip"
			placeholder="Search every session…"
			autocomplete="off"
			spellcheck={false}
			value={query}
			oninput={handleInput}
			onkeydown={handleInputKeydown}
		/>
		<label class="flex items-center gap-2 text-xs text-text-secondary">
			<Checkbox data-testid="deep-search-include-archived" checked={includeArchived} onchange={toggleIncludeArchived} />
			Include archived
		</label>
		<div class="flex items-center justify-between text-xs text-text-dimmer">
			<span>{query.trim() ? "Results" : "Recent"}</span>
			<span aria-live="polite" aria-atomic="true">{announcement}</span>
		</div>
		<div id="deep-search-results" role="listbox" aria-label="Sessions" class="max-h-[55vh] overflow-y-auto">
			{#each results as result, index (result.id)}
				{@const slug = result.projectSlug}
				{@const name = projectName(slug)}
				{@const location = shelf(result)}
				<Button
					variant="ghost"
					size="content"
					layout="flow"
					tone="default"
					hoverFill="surface"
					id={`deep-search-option-${index}`}
					data-testid="deep-search-result"
					role="option"
					aria-selected={highlighted === index}
					ariaLabel={`${result.title || "New Session"}, ${name}, ${location || "Live"}`}
					tabindex={-1}
					class="flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm data-[active=true]:bg-bg-surface"
					data-active={highlighted === index}
					onpointermove={() => (highlighted = index)}
					onclick={() => choose(result)}
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<span class="truncate font-medium">{result.title || "New Session"}</span>
						{#if result.archivedAt != null}<Badge data-testid="session-archived-badge">Archived</Badge>{/if}
					</span>
					<span class="flex items-center gap-1.5 text-xs text-text-secondary">
						<ProjectSquare label={name} accent={projectAccent(slug)} />
						<span class="truncate">{name}</span>
						{#if location}<span>· {location}{location === "Snoozed" && result.snoozedUntil != null ? ` until ${formatSnoozeTime(result.snoozedUntil)}` : ""}</span>{/if}
						<span class="ml-auto shrink-0">{formatTimeAgo(result.updatedAt)}</span>
					</span>
				</Button>
			{/each}
		</div>
		{#if !loading && !failed && query.trim() && results.length === 0}
			<p class="py-4 text-center text-sm text-text-secondary">No sessions match “{query.trim()}”</p>
		{:else if !loading && failed}
			<p class="py-4 text-center text-sm text-text-secondary">{failed}</p>
		{/if}
		{#if hasMore}
			<Button variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="surface" disabledStyle="undimmed" data-testid="deep-search-more" class="self-center rounded px-3 py-2 text-sm text-text-secondary" disabled={loading} onclick={showMore}>Show more</Button>
		{/if}
	</div>
{/snippet}

<Modal {open} onclose={close} title="Search every session" size="lg" placement="center" returnFocus={() => opener} children={body} />

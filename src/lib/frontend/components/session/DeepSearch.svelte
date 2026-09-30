<script lang="ts">
	import { tick } from "svelte";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { switchToSession } from "../../stores/session.svelte.js";
	import { listDaemonSessionsRpc } from "../../transport/ws-rpc-client.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";

	type SearchRpc = typeof listDaemonSessionsRpc;
	type SearchResponse = Awaited<ReturnType<SearchRpc>>;
	type SearchResult = SearchResponse["sessions"][number];

	// The story supplies a transport stub; the app uses the daemon RPC directly.
	let { search = listDaemonSessionsRpc }: { search?: SearchRpc } = $props();

	let open = $state(false);
	let query = $state("");
	let activeQuery = "";
	let results = $state<SearchResult[]>([]);
	let cursor = $state<SearchResponse["nextCursor"]>(null);
	let hasMore = $state(false);
	let loading = $state(false);
	let failed = $state(false);
	let highlighted = $state(-1);
	let input: HTMLInputElement | undefined = $state();
	let opener: HTMLElement | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let requestToken = 0;

	const announcement = $derived(
		failed
			? "Search unavailable"
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
		failed = false;
		highlighted = -1;
		loading = true;
		const trimmed = query.trim();
		debounceTimer = setTimeout(() => void fetchPage(trimmed, true), trimmed ? 150 : 0);
	}

	async function fetchPage(searchQuery: string, replace: boolean): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) {
			loading = false;
			failed = true;
			return;
		}
		const token = replace ? ++requestToken : requestToken;
		if (replace) activeQuery = searchQuery;
		loading = true;
		failed = false;
		try {
			const response = await search({
				projectSlug,
				roots: true,
				limit: searchQuery ? 20 : 8,
				...(searchQuery ? { search: searchQuery } : {}),
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
		} catch {
			if (token === requestToken && open) failed = true;
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
		// conduit-test-vik1.15: viewing a shelf session needs no unsnooze or
		// unsettle mutation, so preserve its shelf state when navigating.
		switchToSession(result.id, result.projectSlug ?? getCurrentSlug() ?? undefined);
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
		<div class="flex items-center justify-between text-xs text-text-dimmer">
			<span>{query.trim() ? "Results" : "Recent"}</span>
			<span aria-live="polite" aria-atomic="true">{announcement}</span>
		</div>
		<div id="deep-search-results" role="listbox" aria-label="Sessions" class="max-h-[55vh] overflow-y-auto">
			{#each results as result, index (result.id)}
				{@const slug = result.projectSlug ?? getCurrentSlug() ?? ""}
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
					<span class="truncate font-medium">{result.title || "New Session"}</span>
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
			<p class="py-4 text-center text-sm text-text-secondary">Search unavailable</p>
		{/if}
		{#if hasMore}
			<Button variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="surface" disabledStyle="undimmed" data-testid="deep-search-more" class="self-center rounded px-3 py-2 text-sm text-text-secondary" disabled={loading} onclick={showMore}>Show more</Button>
		{/if}
	</div>
{/snippet}

<Modal {open} onclose={close} title="Search every session" size="lg" placement="center" returnFocus={() => opener} children={body} />

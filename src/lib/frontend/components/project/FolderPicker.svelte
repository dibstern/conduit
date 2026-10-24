<script lang="ts">
	import type { Rpc } from "effect/rpc";
	import { tick } from "svelte";
	import {
		type FindFolders,
		type FindFoldersResponse,
		ProjectSaveRejected,
	} from "../../transport/ws-rpc.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import DetachedListbox from "../ui/DetachedListbox.svelte";
	import Icon from "../ui/Icon.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { ghost, parseFolderQuery } from "./folder-query.js";

	let {
		selectedPaths,
		ontoggle,
		disabled = false,
		gitInit = $bindable(true),
		findFolders = (input) => rpc("FindFolders", input),
	}: {
		selectedPaths: readonly string[];
		ontoggle: (entry: FindFoldersResponse["entries"][number]) => void;
		disabled?: boolean;
		gitInit?: boolean;
		findFolders?: (input: Rpc.PayloadConstructor<typeof FindFolders>) => Promise<FindFoldersResponse>;
	} = $props();

	const uid = $props.id();
	const listboxId = `${uid}-matches`;
	const optionId = (index: number) => `${listboxId}-${index}`;
	let query = $state("");
	let entries = $state<FindFoldersResponse["entries"]>([]);
	let home = $state("");
	let activeIndex = $state(0);
	let searching = $state(false);
	let lookupError = $state("");
	let input = $state<HTMLInputElement>();
	let ghostLayer = $state<HTMLDivElement>();
	let lookupVersion = 0;
	const isPhone = $derived(sessionViewState.compact);
	const parsed = $derived(parseFolderQuery(query, home));
	const isPathQuery = $derived(parsed.isPath);
	const completion = $derived(ghost(query, entries.filter((entry) => entry.exists), home));
	const existing = $derived(entries.filter((entry) => entry.exists && entry.path !== parsed.folder));
	const newFolder = $derived(entries.find((entry) => !entry.exists));
	const groups = $derived(isPathQuery
		? [{ label: "Matches", entries: existing }]
		: [
			{ label: "Recent", entries: existing.filter((entry) => entry.reason === "recent") },
			{ label: "Repositories nearby", entries: existing.filter((entry) => entry.reason === "sibling") },
			{ label: "Suggestions", entries: existing.filter((entry) => entry.reason === "match") },
		]);
	const matches = $derived(groups.flatMap((group) => group.entries));
	const choices = $derived(newFolder ? [...matches, newFolder] : matches);
	const expanded = $derived(choices.length > 0);

	export function focus(): void {
		input?.focus({ preventScroll: true });
	}

	export function folderQuery(): ReturnType<typeof parseFolderQuery> {
		return parsed;
	}

	export function toggleBrowsedFolder(): boolean {
		if (!parsed.isPath) return false;
		const folder = parsed.folder;
		const entry = entries.find((entry) => entry.path === folder);
		if (folder && !searching && !lookupError && (entry?.exists || (!entry && existing.length > 0))) {
			toggle(entry ?? { path: folder, exists: true, isGitRepo: false, reason: "match" });
		}
		return true;
	}

	$effect(() => {
		if (completion) void tick().then(() => {
			if (ghostLayer) ghostLayer.scrollLeft = input?.scrollLeft ?? 0;
		});
	});

	$effect(() => {
		const currentQuery = query.trim();
		const finder = findFolders;
		const version = ++lookupVersion;
		entries = [];
		lookupError = "";
		activeIndex = 0;
		searching = true;
		const pathQuery = /^[/~]/.test(currentQuery);
		const timer = setTimeout(() => {
			void finder({ query: currentQuery === "~" ? "~/" : currentQuery }).then(
				(response) => {
					if (version !== lookupVersion) return;
					entries = response.entries;
					home = response.home;
					searching = false;
				},
				(error: unknown) => {
					if (version !== lookupVersion) return;
					// An unavailable suggestion list need not interrupt adding a path.
					if (pathQuery) {
						lookupError = error instanceof ProjectSaveRejected
							? error.issues.map((issue) => issue.kind === "permission-denied"
								? `Permission denied: ${issue.path}. Check the folder permissions and try again.`
								: "Couldn't find folders. Try again.").join(" ")
							: failureLine(error, "Couldn't find folders. Try again.");
					}
					searching = false;
				},
			);
		}, 150);
		return () => {
			clearTimeout(timer);
			lookupVersion++;
		};
	});

	function toggle(entry: FindFoldersResponse["entries"][number]): void {
		if (disabled) return;
		ontoggle(entry);
		focus();
	}

	function openFolder(path: string): void {
		if (disabled) return;
		const shown = home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
		query = `${shown.replace(/\/+$/, "")}/`;
		focus();
	}

	function navigateMatches(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.isComposing || disabled) return;
		const atEnd = input?.selectionStart === query.length && input?.selectionEnd === query.length;
		const selected = choices[activeIndex];
		if (event.key === "Tab" && !event.shiftKey && completion) {
			event.preventDefault();
			query += completion;
		} else if (event.key === "Backspace" && atEnd && query.endsWith("/") && parsed.upQuery) {
			event.preventDefault();
			query = parsed.upQuery;
		} else if (event.key === "ArrowRight" && atEnd && selected?.exists) {
			event.preventDefault();
			openFolder(selected.path);
		} else if (event.key === "Enter" || (event.code === "Space" && !isPhone && (query === "" || query.endsWith("/")))) {
			event.preventDefault();
			if (selected) toggle(selected);
		} else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
			void tick().then(() => document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" }));
		}
	}
</script>

<!-- aria-selected exposes the drawn checkbox; the open button is a sibling of the option. -->
{#snippet tickBox(checked: boolean)}
	<span aria-hidden="true" class="grid size-[20px] shrink-0 place-items-center rounded-[6px] border-[1.5px] {checked ? 'border-accent bg-accent text-bg' : 'border-border'}">
		{#if checked}<Icon name="check" size={13} />{/if}
	</span>
{/snippet}

<div data-testid="folder-picker" class="flex flex-col gap-[10px]">
	<div class="relative rounded-[11px] border border-border bg-bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-bg">
		<div class="pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-text-muted"><Icon name="search" size={16} /></div>
		{#if completion}
			<div bind:this={ghostLayer} aria-hidden="true" data-testid="folder-query-ghost" data-phone={isPhone || undefined} class="pointer-events-none absolute inset-y-0 left-[37px] right-[36px] flex items-center overflow-hidden whitespace-pre font-mono text-[14px] data-[phone]:text-[16px] max-md:text-[16px] text-text-muted"><span class="invisible">{query}</span><span>{completion}</span></div>
			{#if !isPhone}<kbd aria-hidden="true" class="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 rounded bg-chip px-[5px] font-mono text-[11px] text-text-secondary">⇥</kbd>{/if}
		{/if}
		<TextInput
			bind:element={input}
			bind:value={query}
			size="content"
			chrome="bare"
			data-phone={isPhone || undefined}
			data-path={isPathQuery || undefined}
			data-completion={Boolean(completion) || undefined}
			class="block h-[40px] data-[phone]:h-[44px] w-full py-[8px] pl-[37px] pr-[12px] data-[completion]:pr-[36px] font-sans data-[path]:font-mono text-[14px] data-[phone]:text-[16px] text-text placeholder:text-text-muted max-md:h-[42px] max-md:text-[16px]"
			placeholder={isPhone ? "Search or type a path" : "Search folders, or type a path…"}
			role="combobox"
			aria-label="Add folder"
			invalid={Boolean(lookupError)}
			aria-describedby={lookupError ? `${uid}-folder-error` : undefined}
			aria-autocomplete={completion ? "both" : "list"}
			aria-haspopup="listbox"
			aria-expanded={expanded}
			aria-controls={expanded ? listboxId : undefined}
			aria-activedescendant={expanded ? optionId(activeIndex) : undefined}
			aria-busy={searching}
			autocomplete="off"
			spellcheck={false}
			autocapitalize="none"
			{disabled}
			onkeydown={navigateMatches}
			onscroll={() => { if (ghostLayer) ghostLayer.scrollLeft = input?.scrollLeft ?? 0; }}
		/>
	</div>
	{#if isPathQuery && parsed.crumbs.length}
		<nav aria-label="Folder breadcrumbs" class="flex flex-wrap items-center gap-[5px] px-[4px] font-mono text-[12.5px] text-text-muted">
			{#each parsed.crumbs as crumb, index (crumb.query)}
				{#if index > 0}<span aria-hidden="true">›</span>{/if}
				<Button variant="ghost" size="content" tone="inherit" disabled={disabled} ariaLabel={crumb.label} aria-current={index === parsed.crumbs.length - 1 ? "location" : undefined} data-current={index === parsed.crumbs.length - 1 || undefined} touchTarget class="rounded-[5px] px-[5px] py-[2px] data-[current]:bg-chip data-[current]:text-text data-[current]:font-medium" onclick={() => { query = crumb.query; focus(); }}>{crumb.label}</Button>
			{/each}
		</nav>
	{/if}
	{#if expanded}
		<div class="relative">
			<DetachedListbox id={listboxId} ariaLabel="Folder matches" aria-multiselectable="true" class="overflow-y-auto" style={`border: none; background: transparent; box-shadow: none; ${isPhone ? "" : `max-height: 280px; scroll-padding-bottom: ${newFolder ? 44 : 0}px;`}`}>
				{#each groups as group (group.label)}
					{#if group.entries.length}
						<div role="group" aria-label={group.label}>
							{#if !isPathQuery}<div class="px-[4px] pt-[4px] pb-[4px] font-mono text-[10.5px] font-semibold uppercase tracking-widest text-text-muted">{group.label}</div>{/if}
							{#each group.entries as entry (entry.path)}
								{@const index = matches.indexOf(entry)}
								{@const name = entry.path.split("/").filter(Boolean).at(-1) ?? entry.path}
								{@const shown = home && (entry.path === home || entry.path.startsWith(`${home}/`)) ? `~${entry.path.slice(home.length)}` : entry.path}
								{@const metadata = entry.isGitRepo ? (entry.branch ? `git · ${entry.branch}` : "git") : entry.repoCount ? `${entry.repoCount} repos` : ""}
								<div data-active={activeIndex === index || undefined} data-disabled={disabled || undefined} class="flex items-center rounded-[10px] pr-[6px] text-text hover:bg-hover data-[active]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
								<div role="option" id={optionId(index)} aria-label={entry.path} aria-selected={selectedPaths.includes(entry.path)} aria-disabled={disabled} tabindex={-1} data-testid="folder-picker-row" data-path={entry.path} data-phone={isPhone || undefined} class="flex h-[44px] min-w-0 flex-1 cursor-pointer items-center gap-[11px] px-[10px] pr-[6px] data-[phone]:h-[52px] data-[phone]:pl-[4px]" onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = index} onclick={() => toggle(entry)} onkeydown={navigateMatches}>
									{@render tickBox(selectedPaths.includes(entry.path))}
									<div class="min-w-0 flex-1">
										<div class={isPhone ? "truncate text-[15px] leading-[20px]" : "truncate text-[14px] leading-[20px]"}>{name}</div>
										{#if isPathQuery}
											{#if isPhone && metadata}<div class="truncate font-mono text-[12px] leading-[16px] text-text-muted">{metadata}</div>{/if}
										{:else}<div class="truncate font-mono text-[12px] leading-[16px] text-text-muted" title={entry.path}>{shown}</div>{/if}
									</div>
									{#if metadata && (!isPathQuery || !isPhone)}<Badge variant="chip" class="max-w-[45%] truncate">{metadata}</Badge>{/if}
								</div>
								<Button variant="ghost" size="content" tone="muted" iconOnly icon="chevron-right" iconSize={isPhone ? 18 : 16} ariaLabel={`Open folder: ${entry.path}`} aria-hidden="true" tabindex={-1} data-testid="folder-picker-open" data-path={entry.path} class="h-[30px] w-[30px] shrink-0 rounded-[8px]" touchTarget disabled={disabled} onpointerdown={(event) => event.preventDefault()} onclick={() => openFolder(entry.path)} />
								</div>
							{/each}
						</div>
					{/if}
				{/each}
				{#if newFolder}
					<div class={`bg-bg-alt md:sticky md:bottom-0 ${matches.length ? "border-t border-border-subtle" : ""}`}>
						<div role="option" id={optionId(matches.length)} aria-selected={selectedPaths.includes(newFolder.path)} aria-disabled={disabled} tabindex={-1} data-phone={isPhone || undefined} class={`flex min-h-[44px] data-[phone]:min-h-[52px] cursor-pointer items-center gap-[7px] py-[6px] pl-[10px] pr-[90px] text-[12px] text-text ${activeIndex === matches.length ? "bg-hover" : ""} ${disabled ? "pointer-events-none opacity-50" : ""}`} onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = matches.length} onclick={() => newFolder && toggle(newFolder)} onkeydown={navigateMatches}>
							{#if selectedPaths.includes(newFolder.path)}{@render tickBox(true)}{:else}<Icon name="plus" size={16} class="shrink-0 text-text-muted" />{/if}<span class="min-w-0 truncate">New folder "{newFolder.path.split("/").filter(Boolean).at(-1) ?? newFolder.path}"</span>
						</div>
					</div>
				{/if}
			</DetachedListbox>
			{#if newFolder && !selectedPaths.includes(newFolder.path)}
				<label class="absolute right-[8px] bottom-[3px] flex min-h-[38px] cursor-pointer items-center gap-[4px] font-mono text-[10px] text-text-secondary">
					<Checkbox bind:checked={gitInit} aria-label="git init" {disabled} /><span>git init</span>
				</label>
			{/if}
		</div>
	{/if}
	{#if isPathQuery && !isPhone}
		<div role="note" aria-label="Folder keyboard shortcuts" class="flex flex-wrap items-center gap-x-[14px] gap-y-[4px] px-[4px] text-[12px] text-text-muted">
			{#each [["↑↓", "move"], ["␣", "check"], ["→", "open"], ["⌫", "up a level"], ...(parsed.folder ? [["⌘↵", `check “${parsed.crumbs.at(-1)?.label}”`]] : [])] as [key, label]}
				<span><kbd class="rounded bg-chip px-[5px] py-[1px] font-mono text-[11px] font-medium text-text-secondary">{key}</kbd> {label}</span>
			{/each}
		</div>
	{/if}
	{#if lookupError}<p id={`${uid}-folder-error`} role="alert" class="break-words text-[11px] text-error">{lookupError}</p>{/if}
</div>

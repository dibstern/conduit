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
	import Checkbox from "../ui/Checkbox.svelte";
	import DetachedListbox from "../ui/DetachedListbox.svelte";
	import Icon from "../ui/Icon.svelte";
	import TextInput from "../ui/TextInput.svelte";

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
	let lookupVersion = 0;
	const isPathQuery = $derived(/^[/~]/.test(query.trim()));
	const existing = $derived(entries.filter((entry) => entry.exists));
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
			void finder({ query: currentQuery }).then(
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

	function navigateMatches(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.isComposing || disabled) return;
		if (event.key === "Enter") {
			event.preventDefault();
			const selected = choices[activeIndex];
			if (selected) toggle(selected);
		} else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
			void tick().then(() => document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" }));
		}
	}
</script>

<!-- A drawn box, not an <input>: an option row must not nest a focusable control,
     and aria-selected already tells assistive tech the row is ticked. -->
{#snippet tickBox(checked: boolean)}
	<span aria-hidden="true" class="grid size-[20px] shrink-0 place-items-center rounded-[6px] border-[1.5px] {checked ? 'border-accent bg-accent text-bg' : 'border-border'}">
		{#if checked}<Icon name="check" size={13} />{/if}
	</span>
{/snippet}

<div data-testid="folder-picker" class="flex flex-col gap-[10px]">
	<div class="relative rounded-[11px] border border-border bg-bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-bg">
		<div class="pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-text-muted"><Icon name="search" size={16} /></div>
		<TextInput
			bind:element={input}
			bind:value={query}
			size="content"
			chrome="bare"
			class="block h-[40px] w-full py-[8px] pl-[37px] pr-[12px] font-sans text-[14px] text-text placeholder:text-text-muted max-md:h-[42px] max-md:text-[16px]"
			placeholder="Search folders, or type a path…"
			role="combobox"
			aria-label="Add folder"
			invalid={Boolean(lookupError)}
			aria-describedby={lookupError ? `${uid}-folder-error` : undefined}
			aria-autocomplete="list"
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
		/>
	</div>
	{#if expanded}
		<div class="relative">
			<DetachedListbox id={listboxId} ariaLabel="Folder matches" aria-multiselectable="true" class="overflow-y-auto" style={`border: none; background: transparent; box-shadow: none; ${sessionViewState.compact ? "" : `max-height: 280px; scroll-padding-bottom: ${newFolder ? 44 : 0}px;`}`}>
				{#each groups as group (group.label)}
					{#if group.entries.length}
						<div role="group" aria-label={group.label}>
							<div class="px-[4px] pt-[4px] pb-[4px] font-mono text-[10.5px] font-semibold uppercase tracking-widest text-text-muted">{group.label}</div>
							{#each group.entries as entry (entry.path)}
								{@const index = matches.indexOf(entry)}
								{@const name = entry.path.split("/").filter(Boolean).at(-1) ?? entry.path}
								{@const shown = home && (entry.path === home || entry.path.startsWith(`${home}/`)) ? `~${entry.path.slice(home.length)}` : entry.path}
								<div role="option" id={optionId(index)} aria-label={entry.path} aria-selected={selectedPaths.includes(entry.path)} aria-disabled={disabled} tabindex={-1} data-testid="folder-picker-row" data-path={entry.path} class={`flex h-[44px] cursor-pointer items-center gap-[11px] rounded-[10px] px-[10px] text-text hover:bg-hover ${activeIndex === index ? "bg-hover" : ""} ${disabled ? "pointer-events-none opacity-50" : ""}`} onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = index} onclick={() => toggle(entry)} onkeydown={navigateMatches}>
									{@render tickBox(selectedPaths.includes(entry.path))}
									<div class="min-w-0 flex-1">
										<div class="truncate text-[14px] leading-[20px]">{name}</div>
										<div class="truncate font-mono text-[12px] leading-[16px] text-text-muted" title={entry.path}>{shown}</div>
									</div>
									{#if entry.isGitRepo}<Badge variant="chip">git</Badge>{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/each}
				{#if newFolder}
					<div class={`bg-bg-alt md:sticky md:bottom-0 ${matches.length ? "border-t border-border-subtle" : ""}`}>
						<div role="option" id={optionId(matches.length)} aria-selected={selectedPaths.includes(newFolder.path)} aria-disabled={disabled} tabindex={-1} class={`flex min-h-[44px] cursor-pointer items-center gap-[7px] py-[6px] pl-[10px] pr-[90px] text-[12px] text-text ${activeIndex === matches.length ? "bg-hover" : ""} ${disabled ? "pointer-events-none opacity-50" : ""}`} onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = matches.length} onclick={() => newFolder && toggle(newFolder)} onkeydown={navigateMatches}>
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
	{#if lookupError}<p id={`${uid}-folder-error`} role="alert" class="break-words text-[11px] text-error">{lookupError}</p>{/if}
</div>

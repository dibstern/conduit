<script lang="ts">
	import { onMount, tick } from "svelte";
	import {
		ProjectSaveRejected,
		type FindFoldersResponse,
		type SaveProjectResponse,
	} from "../../transport/ws-rpc.js";
	import type { FolderIssue } from "../../../project-folders.js";
	import {
		addFolder,
		check,
		createDraft,
		folderPath,
		makeMain,
		removeFolder,
		rename,
		type ProjectDraft,
	} from "../../../project-draft.js";
	import type { ProjectInfo } from "../../types.js";
	import {
		findFoldersRpc,
		saveProjectRpc,
		type FindFoldersRpcInput,
		type SaveProjectRpcInput,
	} from "../../transport/ws-rpc-client.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import DetachedListbox from "../ui/DetachedListbox.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let {
		open,
		projects = [],
		onclose,
		onsaved,
		returnFocus,
		findFolders = findFoldersRpc,
		saveProject = saveProjectRpc,
	}: {
		open: boolean;
		projects?: readonly ProjectInfo[];
		onclose: () => void;
		onsaved?: (response: SaveProjectResponse) => void;
		returnFocus?: () => HTMLElement | null;
		findFolders?: (input: FindFoldersRpcInput) => Promise<FindFoldersResponse>;
		saveProject?: (input: SaveProjectRpcInput) => Promise<SaveProjectResponse>;
	} = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const hintId = `${uid}-hint`;
	const listboxId = `${uid}-matches`;
	const optionId = (index: number) => `${listboxId}-${index}`;
	let draft = $state<ProjectDraft>(createDraft());
	let query = $state("");
	let entries = $state<FindFoldersResponse["entries"]>([]);
	let activeIndex = $state(0);
	let gitInit = $state(true);
	let searching = $state(false);
	let saving = $state(false);
	let attemptedSave = $state(false);
	let saveIssues = $state<readonly FolderIssue[]>([]);
	let addIssues = $state<readonly FolderIssue[]>([]);
	let lookupError = $state("");
	let saveError = $state("");
	let input = $state<HTMLInputElement>();
	let isPhone = $state(false);
	let viewportHeight = $state(0);
	let keyboardInset = $state(0);
	let lookupVersion = 0;
	let saveVersion = 0;

	const matches = $derived(entries.filter((entry) => entry.exists));
	const newFolder = $derived(entries.find((entry) => !entry.exists));
	const choices = $derived(newFolder ? [...matches, newFolder] : matches);
	const expanded = $derived(choices.length > 0);
	const issues = $derived(check(draft, projects));
	const errors = $derived([
		...(draft.folders.length || attemptedSave ? issues.errors : []),
		...addIssues,
		...saveIssues,
	]);
	const canSave = $derived(!saving && issues.errors.length === 0 && !issues.nameError);

	onMount(() => {
		const phone = window.matchMedia("(max-width: 767px)");
		const viewport = window.visualViewport;
		function measure(): void {
			isPhone = phone.matches;
			viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
			keyboardInset = Math.max(0, window.innerHeight - viewportHeight - (viewport?.offsetTop ?? 0));
		}
		measure();
		phone.addEventListener("change", measure);
		viewport?.addEventListener("resize", measure);
		viewport?.addEventListener("scroll", measure);
		window.addEventListener("resize", measure);
		return () => {
			phone.removeEventListener("change", measure);
			viewport?.removeEventListener("resize", measure);
			viewport?.removeEventListener("scroll", measure);
			window.removeEventListener("resize", measure);
		};
	});

	$effect(() => {
		if (!open) {
			lookupVersion++;
			saveVersion++;
			return;
		}
		draft = createDraft();
		query = "";
		entries = [];
		addIssues = [];
		saveIssues = [];
		saveError = "";
		attemptedSave = false;
		gitInit = true;
		saving = false;
		void tick().then(() => {
			if (open) input?.focus({ preventScroll: true });
		});
	});

	$effect(() => {
		const currentQuery = query.trim();
		const finder = findFolders;
		const version = ++lookupVersion;
		entries = [];
		lookupError = "";
		searching = false;
		activeIndex = 0;
		if (!open || !(currentQuery.startsWith("/") || currentQuery.startsWith("~"))) return;
		searching = true;
		const timer = setTimeout(() => {
			void finder({ query: currentQuery }).then(
				(response) => {
					if (version !== lookupVersion) return;
					entries = response.entries;
					searching = false;
				},
				(error: unknown) => {
					if (version !== lookupVersion) return;
					lookupError = error instanceof Error ? error.message : "Couldn't find folders. Try again.";
					searching = false;
				},
			);
		}, 150);
		return () => {
			clearTimeout(timer);
			lookupVersion++;
		};
	});

	function changed(next: ProjectDraft): void {
		draft = next;
		saveIssues = [];
		saveError = "";
		addIssues = [];
	}

	function changeFolders(next: ProjectDraft): void {
		changed(next);
		input?.focus({ preventScroll: true });
	}

	function choose(entry: FindFoldersResponse["entries"][number]): void {
		if (saving) return;
		const result = addFolder(draft, entry.exists ? entry.path : { path: entry.path, create: { gitInit } });
		changeFolders(result.draft);
		addIssues = result.errors;
		query = "";
		entries = [];
		gitInit = true;
	}

	function navigateMatches(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.isComposing || saving) return;
		if (event.key === "Enter") {
			event.preventDefault();
			const selected = choices[activeIndex];
			if (selected) choose(selected);
		} else if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
			void tick().then(() => document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" }));
		}
	}

	async function save(): Promise<void> {
		if (saving) return;
		attemptedSave = true;
		if (issues.errors.length || issues.nameError) return;
		const version = ++saveVersion;
		saving = true;
		saveIssues = [];
		saveError = "";
		try {
			const response = await saveProject({ title: draft.name, folders: draft.folders });
			if (!open || version !== saveVersion) return;
			onsaved?.(response);
			onclose();
		} catch (error) {
			if (!open || version !== saveVersion) return;
			if (error instanceof ProjectSaveRejected) saveIssues = error.issues;
			else saveError = error instanceof Error ? error.message : "Couldn't save the project. Try again.";
		} finally {
			if (version === saveVersion) saving = false;
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
			event.preventDefault();
			void save();
		}
	}

	function issueText(issue: FolderIssue): string {
		switch (issue.kind) {
			case "empty": return "Add at least one folder.";
			case "duplicate": return `${issue.path} is already added.`;
			case "main-taken": return `${issue.path} is already the main folder of`;
			case "nested": return `${issue.path} is inside ${issue.parent}. Sessions can already edit it.`;
			case "missing": return `${issue.path} no longer exists.`;
			case "not-a-folder": return `${issue.path} isn't a folder.`;
			case "create-exists": return `${issue.path} already exists. Add it as an existing folder.`;
			case "mkdir-failed": return `Couldn't create ${issue.path}: ${issue.message}`;
			case "git-init-failed": return `Couldn't initialise git in ${issue.path}: ${issue.message}`;
			case "unknown-project": return `Project ${issue.slug} no longer exists.`;
			case "sessions-running": return `${issue.count} sessions are running. Save when they finish.`;
		}
	}
</script>

{#snippet pathLabel(path: string)}
	<!-- Dim parent, bright name: the name is what tells sibling folders apart. -->
	{@const cut = path.lastIndexOf("/", path.length - 2) + 1}
	<span class="flex min-w-0 flex-1" title={path}><span class="min-w-0 truncate text-text-secondary">{path.slice(0, cut)}</span><span class="min-w-0 max-w-full shrink-0 truncate text-text">{path.slice(cut)}</span></span>
{/snippet}

<Dialog {open} {onclose} {returnFocus} labelledBy={titleId} describedBy={hintId} placement={isPhone ? "sheet" : "top"} dismissible={!saving}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<Surface
		variant="raised"
		radius="none"
		elevation="modal"
		class="project-dialog flex w-[420px] max-w-[calc(100vw-24px)] flex-col gap-[9px] rounded-[14px] p-[14px] max-md:w-screen max-md:max-w-none max-md:rounded-none max-md:border-x-0 max-md:p-[16px]"
		style={`max-height: ${isPhone ? `${viewportHeight}px` : "80dvh"}; ${isPhone ? `height: ${viewportHeight}px; transform: translateY(-${keyboardInset}px);` : ""}`}
		data-testid="project-dialog"
		onkeydown={handleKeydown}
	>
		<header class="flex shrink-0 items-center gap-[8px]">
			<h2 id={titleId} class="flex-1 text-[14px] font-semibold text-text">Add project</h2>
			<div class="w-[150px] min-w-0">
				<TextInput aria-label="Project name" aria-describedby={issues.nameError ? `${uid}-name-error` : undefined} invalid={Boolean(issues.nameError)} placeholder="Project name" size="content" class="h-[28px] px-[8px] text-[12px] max-md:h-[44px] max-md:text-[16px]" value={draft.name} disabled={saving} oninput={(event) => changed(rename(draft, event.currentTarget.value))} />
			</div>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
			<div class="flex flex-col gap-[9px]">
				<div class="relative">
					<div class="pointer-events-none absolute left-[8px] top-1/2 -translate-y-1/2 text-text-muted"><Icon name="search" size={13} /></div>
					<TextInput
						bind:element={input}
						bind:value={query}
						size="content"
						class={`h-[32px] py-[6px] pl-[28px] font-mono ${expanded ? "pr-[56px] max-md:pr-[8px] pointer-coarse:pr-[8px]" : "pr-[8px]"} text-[12px] max-md:h-[44px] max-md:text-[16px]`}
						placeholder="Type a folder path, / or ~"
						role="combobox"
						aria-label="Add folder"
						aria-autocomplete="list"
						aria-haspopup="listbox"
						aria-expanded={expanded}
						aria-controls={expanded ? listboxId : undefined}
						aria-activedescendant={expanded ? optionId(activeIndex) : undefined}
						aria-busy={searching}
						autocomplete="off"
						spellcheck={false}
						autocapitalize="none"
						disabled={saving}
						onkeydown={navigateMatches}
					/>
					{#if expanded}<kbd aria-hidden="true" class="pointer-events-none absolute right-[8px] top-1/2 -translate-y-1/2 font-mono text-[9px] text-text-muted max-md:hidden pointer-coarse:hidden">↵ add</kbd>{/if}
				</div>
				{#if expanded}
					<div class="relative">
						<DetachedListbox id={listboxId} ariaLabel="Folder matches" class="overflow-y-auto" style={isPhone ? undefined : `max-height: 200px; scroll-padding-bottom: ${newFolder ? 34 : 0}px;`}>
							{#if matches.length}
								<div role="group" aria-label="Matches">
									<div class="px-[8px] pt-[4px] pb-[2px] font-mono text-[9px] uppercase tracking-widest text-text-muted">Matches</div>
									{#each matches as entry, index (entry.path)}
										<Button role="option" id={optionId(index)} aria-selected={activeIndex === index} tabindex={-1} ariaLabel={entry.path} variant={activeIndex === index ? "accent-soft" : "ghost"} tone="default" size="content" align="start" class="w-full min-h-[30px] gap-[7px] px-[8px] py-[6px] text-left font-mono text-[11px] max-md:min-h-[44px]" onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = index} onclick={() => choose(entry)}>
											<Icon name={entry.isGitRepo ? "git-branch" : "folder"} size={13} class="shrink-0 text-text-muted" />
											{@render pathLabel(entry.path)}
											{#if entry.isGitRepo}<span class="shrink-0 text-[10px] text-text-secondary">git</span>{/if}
										</Button>
									{/each}
								</div>
							{/if}
							{#if newFolder}
								<div class={`bg-bg-alt md:sticky md:bottom-0 ${matches.length ? "border-t border-border-subtle" : ""}`}>
									<Button role="option" id={optionId(matches.length)} aria-selected={activeIndex === matches.length} tabindex={-1} variant={activeIndex === matches.length ? "accent-soft" : "ghost"} tone="default" size="content" align="start" class="min-h-[30px] w-full min-w-0 gap-[7px] py-[6px] pl-[8px] pr-[80px] text-left text-[11px] max-md:min-h-[44px]" onpointerdown={(event) => event.preventDefault()} onpointerenter={() => activeIndex = matches.length} onclick={() => newFolder && choose(newFolder)}>
										<Icon name="plus" size={13} class="shrink-0 text-text-muted" /><span class="min-w-0 truncate">New folder "{newFolder.path.split("/").filter(Boolean).at(-1) ?? newFolder.path}"</span>
									</Button>
								</div>
							{/if}
						</DetachedListbox>
						{#if newFolder}
							<!-- Keep this control outside the listbox's option semantics. -->
							<label class="absolute right-[8px] bottom-[3px] flex min-h-[30px] cursor-pointer items-center gap-[4px] font-mono text-[10px] text-text-secondary max-md:min-h-[44px]">
								<Checkbox bind:checked={gitInit} aria-label="git init" disabled={saving} /><span>git init</span>
							</label>
						{/if}
					</div>
				{/if}
				{#if lookupError}<p role="alert" class="break-words text-[11px] text-error">{lookupError}</p>{/if}
				<p id={hintId} class="font-mono text-[9px] uppercase tracking-wider text-text-muted">Folders · Sessions run in main and can edit all</p>
				{#if draft.folders.length === 0}
					<p class="py-[12px] text-[12px] text-text-muted">No folders added yet</p>
				{:else}
					<ul aria-label="Project folders" class="flex flex-col gap-[7px]">
						{#each draft.folders as folder, index (folderPath(folder))}
							{@const path = folderPath(folder)}
							<li data-testid="project-folder-row" aria-label={`${index === 0 ? "Main" : "Extra"} folder: ${path}`}>
								<Surface variant="inset" radius="md" class="flex items-center gap-[7px] px-[8px] py-[6px] max-md:min-h-[56px]">
									<Icon name="folder" size={13} class="shrink-0 text-text-muted" />
									<div class="min-w-0 flex-1 font-mono text-[11px]">{@render pathLabel(path)}{#if typeof folder !== "string" && folder.create.gitInit}<span class="text-[9px] text-text-muted">git init</span>{/if}</div>
									{#if typeof folder !== "string"}<Badge variant="quiet">new</Badge>{/if}
									{#if index === 0}<Badge variant="accent-solid" class="font-mono">MAIN</Badge>{:else}<Button variant="secondary" size="sm" ariaLabel={`Make main: ${path}`} class="max-md:min-h-[44px]" disabled={saving} onclick={() => changeFolders(makeMain(draft, path))}>Make main</Button>{/if}
									<Button variant="ghost" size="sm" iconOnly icon="x" ariaLabel={`Remove folder: ${path}`} touchTarget disabled={saving} onclick={() => changeFolders(removeFolder(draft, path))} />
								</Surface>
							</li>
						{/each}
					</ul>
				{/if}
				{#if errors.length || saveError || issues.nameError}
					<div role="alert" class="flex flex-col gap-[5px] break-words text-[11px] text-error">
						{#if issues.nameError}<p id={`${uid}-name-error`}>{issues.nameError}</p>{/if}
						{#each errors as issue}<p>{issueText(issue)}{#if issue.kind === "main-taken"}{" "}<Button href={`/?p=${encodeURIComponent(issue.slug)}`} variant="ghost-accent" size="content" touchTarget class="underline" onclick={onclose}>{projects.find((project) => project.slug === issue.slug)?.title ?? issue.slug}</Button>.{/if}</p>{/each}
						{#if saveError}<p>{saveError}</p>{/if}
					</div>
				{/if}
				{#if issues.warnings.length}<div role="status" class="flex flex-col gap-[5px] break-words text-[11px] text-warning">{#each issues.warnings as issue}<p>{issueText(issue)}</p>{/each}</div>{/if}
			</div>
		</div>
		<footer class="flex shrink-0 justify-end gap-[7px] pt-[2px] max-md:pb-[env(safe-area-inset-bottom)]">
			<Button variant="secondary" size="md" class="max-md:min-h-[44px]" disabled={saving} onclick={onclose}>Cancel</Button>
			<Button variant="primary" size="md" ariaLabel="Add project" class="max-md:min-h-[44px]" loading={saving} disabled={!canSave} onclick={() => void save()}>Add project <span aria-hidden="true" class="font-mono text-[9px] max-md:hidden pointer-coarse:hidden">⌘↵</span></Button>
		</footer>
	</Surface>
</Dialog>

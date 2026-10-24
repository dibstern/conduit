<script lang="ts">
	import type { Rpc } from "effect/rpc";
	import { onMount, tick } from "svelte";
	import { applyProjectList, projectState } from "../../stores/project.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import {
		type FindFolders,
		type FindFoldersResponse,
		ProjectSaveRejected,
		type SaveProject,
		type SaveProjectResponse,
	} from "../../transport/ws-rpc.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Icon from "../ui/Icon.svelte";
	import FolderPicker from "./FolderPicker.svelte";
	import { issueText } from "./folder-issue-text.js";

	let {
		oncomplete,
		findFolders = (input) => rpc("FindFolders", input),
		saveProject = (input) => rpc("SaveProject", input),
	}: {
		oncomplete: () => void;
		findFolders?: (input: Rpc.PayloadConstructor<typeof FindFolders>) => Promise<FindFoldersResponse>;
		saveProject?: (input: Rpc.PayloadConstructor<typeof SaveProject>) => Promise<SaveProjectResponse>;
	} = $props();

	const uid = $props.id();
	let selected = $state<string[]>([]);
	let recent = $state<FindFoldersResponse["entries"]>([]);
	let home = $state("");
	let loading = $state(true);
	let lookupError = $state("");
	let errors = $state<Record<string, string>>({});
	let browsing = $state(false);
	let saving = $state(false);
	let picker = $state<FolderPicker>();
	const isPhone = $derived(sessionViewState.compact);
	const projectFolders = $derived(new Set(projectState.projects.flatMap((project) => project.folders)));
	const rows = $derived([
		...recent,
		...selected.filter((path) => !recent.some((entry) => entry.path === path)).map((path) => ({ path, lastUsed: undefined })),
	].filter((entry) => !projectFolders.has(entry.path)));

	onMount(() => {
		let active = true;
		void findFolders({ query: "" }).then((response) => {
			if (!active) return;
			home = response.home;
			recent = response.entries.filter((entry) => entry.reason === "recent" && entry.lastUsed !== undefined)
				.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
			selected = recent.filter((entry) => !projectFolders.has(entry.path)).slice(0, 3).map((entry) => entry.path);
		}, (error: unknown) => {
			if (active) lookupError = failureLine(error, "Couldn't find recent repositories. Find a folder below.");
		}).finally(() => { if (active) loading = false; });
		return () => { active = false; };
	});

	function toggle(path: string): void {
		if (saving || projectFolders.has(path)) return;
		selected = selected.includes(path) ? selected.filter((value) => value !== path) : [...selected, path];
		delete errors[path];
	}

	function lastUsed(timestamp: number | undefined): string {
		const text = formatTimeAgo(timestamp).toLowerCase();
		return isPhone ? (text === "yesterday" ? "1d" : text.replace(/ ago$/, "")) : text;
	}

	async function browse(): Promise<void> {
		browsing = !browsing;
		if (browsing) {
			await tick();
			picker?.focus();
		}
	}

	async function save(): Promise<void> {
		if (saving) return;
		// After a partial failure the user can untick what failed and keep what saved.
		if (selected.length === 0) {
			if (projectState.projects.length > 0) oncomplete();
			return;
		}
		saving = true;
		errors = {};
		// Replacing selected on success leaves this iteration in the user's original order.
		for (const path of selected) {
			try {
				if (!projectFolders.has(path)) {
					const response = await saveProject({ title: path.split("/").filter(Boolean).at(-1) ?? path, folders: [path] });
					applyProjectList(response);
				}
				selected = selected.filter((value) => value !== path);
			} catch (error) {
				errors[path] = error instanceof ProjectSaveRejected
					? error.issues.map((issue) => issue.kind === "main-taken" ? `${issueText(issue)} ${projectState.projects.find((project) => project.slug === issue.slug)?.title || issue.slug}.` : issueText(issue)).join(" ")
					: failureLine(error, "Couldn't save the project. Try again.");
			}
		}
		saving = false;
		if (selected.length === 0) oncomplete();
	}
</script>

<main data-testid="first-run-projects" data-phone={isPhone || undefined} aria-labelledby={`${uid}-title`} class="h-dvh overflow-y-auto bg-bg px-[16px] pt-[70px] pb-[30px] font-sans text-text data-[phone]:px-[18px]">
	<div class="mx-auto w-full max-w-[520px]">
		<header class="text-center">
			<span class="mx-auto grid size-[44px] place-items-center rounded-[12px] bg-accent-bg text-accent"><Icon name="folder-plus" size={22} /></span>
			<h1 id={`${uid}-title`} class="mt-[14px] text-[19px] font-semibold leading-[normal] data-[phone]:text-[17px]" data-phone={isPhone || undefined}>Add your projects</h1>
			<p class="mt-[4px] text-[13.5px] leading-[1.5] text-text-secondary">{isPhone ? "Repos you've worked in recently. Each becomes a project." : "Repos you've worked in recently on this machine. Each one becomes a project."}</p>
		</header>
		{#if loading}
			<p role="status" class="mt-[22px] text-center text-[13.5px] text-text-muted">Finding recent repositories…</p>
		{:else if rows.length}
			<ul data-testid="first-run-repos" aria-label="Recent repositories" data-phone={isPhone || undefined} class="mt-[22px] list-none rounded-[12px] border border-border bg-bg-surface p-[4px] data-[phone]:mt-[20px] data-[phone]:p-[2px]">
				{#each rows as row, index (row.path)}
					{@const name = row.path.split("/").filter(Boolean).at(-1) ?? row.path}
					{@const shown = home && (row.path === home || row.path.startsWith(`${home}/`)) ? `~${row.path.slice(home.length)}` : row.path}
					<li data-testid="first-run-repo" data-path={row.path}>
						<label data-phone={isPhone || undefined} class="flex min-h-[46px] cursor-pointer items-center gap-[11px] rounded-[10px] py-[4px] pr-[6px] pl-[10px] hover:bg-hover data-[phone]:min-h-[54px]">
							<span class="relative grid size-[20px] shrink-0 place-items-center">
								<Checkbox checked={selected.includes(row.path)} onchange={() => toggle(row.path)} disabled={saving} aria-label={name} aria-describedby={errors[row.path] ? `${uid}-error-${index}` : undefined} class="m-0 size-[20px] appearance-none rounded-[6px] border-[1.5px] border-border checked:border-accent checked:bg-accent" />
								{#if selected.includes(row.path)}<span class="pointer-events-none absolute text-bg"><Icon name="check" size={13} /></span>{/if}
							</span>
							<span class="min-w-0 flex-1">
								<span data-phone={isPhone || undefined} class="block truncate text-[14px] leading-[20px] data-[phone]:text-[15px]">{name}</span>
								<span class="block truncate font-mono text-[12px] leading-[18px] text-text-muted" title={row.path}>{shown}</span>
							</span>
							{#if row.lastUsed !== undefined}<span class="shrink-0 text-[12.5px] text-text-muted">{lastUsed(row.lastUsed)}</span>{/if}
						</label>
						{#if errors[row.path]}<p id={`${uid}-error-${index}`} role="alert" class="px-[10px] pb-[8px] text-[12px] text-error">{errors[row.path]}</p>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-[22px] text-center text-[13.5px] text-text-muted">No recent repositories found. Find a folder to get started.</p>
		{/if}
		{#if lookupError}<p role="alert" class="mt-[12px] text-[12px] text-error">{lookupError}</p>{/if}
		<div data-phone={isPhone || undefined} class="mt-[18px] flex items-center gap-[10px] data-[phone]:mt-[20px] data-[phone]:flex-col data-[phone]:gap-[14px]">
			<Button variant="ghost" size="content" tone="accent" hoverFill="none" disabled={loading || saving} aria-expanded={browsing} data-phone={isPhone || undefined} class="flex items-center gap-[7px] text-[14px] data-[phone]:order-2" onclick={() => void browse()}>
				{#if !isPhone}<Icon name="search" size={15} />{/if}
				{isPhone ? "Find another folder…" : "Find or browse for another folder…"}
			</Button>
			<Button variant="primary" size="content" disabled={(selected.length === 0 && projectState.projects.length === 0) || saving} loading={saving} data-phone={isPhone || undefined} class="ml-auto h-[34px] rounded-full px-[14px] text-[13.5px] font-medium data-[phone]:ml-0 data-[phone]:h-[46px] data-[phone]:w-full data-[phone]:text-[15px]" onclick={() => void save()}>{selected.length === 0 && projectState.projects.length > 0 ? "Continue" : `Add ${selected.length} ${selected.length === 1 ? "project" : "projects"}`}</Button>
		</div>
		{#if browsing}
			<div class="mt-[20px]">
				<FolderPicker bind:this={picker} selectedPaths={selected} ontoggle={(entry) => toggle(entry.path)} initialQuery="~/" allowCreate={false} disabled={saving} {findFolders} />
			</div>
		{/if}
	</div>
</main>

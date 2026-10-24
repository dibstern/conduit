<script lang="ts">
	import type { Rpc } from "effect/rpc";
	import { onMount, tick } from "svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import type { SessionMode } from "../../../contracts/project-file.js";
	import {
		type FindFolders,
		ProjectSaveRejected,
		type FindFoldersResponse,
		type SaveProject,
		type SaveProjectResponse,
	} from "../../transport/ws-rpc.js";
	import { type FolderIssue, labelProjectFolders } from "../../../project-folders.js";
	import {
		addFolder,
		check,
		createDraft,
		folderPath,
		isDirty,
		makeMain,
		removeFolder,
		rename,
		type ProjectDraft,
	} from "../../../project-draft.js";
	import type { OpenCodeInstance, ProjectInfo } from "../../types.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Field from "../ui/Field.svelte";
	import Select from "../ui/Select.svelte";
	import Surface from "../ui/Surface.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import FolderPicker from "./FolderPicker.svelte";

	let {
		open,
		project,
		projects = [],
		instances,
		onclose,
		onsaved,
		returnFocus,
		findFolders = (input) => rpc("FindFolders", input),
		saveProject = (input) => rpc("SaveProject", input),
	}: {
		open: boolean;
		/** Opens the dialog in Edit mode for this project. */
		project?: ProjectInfo | undefined;
		projects?: readonly ProjectInfo[];
		instances?: readonly Pick<OpenCodeInstance, "id" | "name" | "capabilities">[];
		onclose: () => void;
		onsaved?: (response: SaveProjectResponse) => void;
		returnFocus?: () => HTMLElement | null;
		findFolders?: (input: Rpc.PayloadConstructor<typeof FindFolders>) => Promise<FindFoldersResponse>;
		saveProject?: (input: Rpc.PayloadConstructor<typeof SaveProject>) => Promise<SaveProjectResponse>;
	} = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const hintId = `${uid}-hint`;
	let draft = $state<ProjectDraft>(createDraft());
	let setupScript = $state("");
	let sessionMode = $state<SessionMode | "">("");
	let gitInit = $state(true);
	let saving = $state(false);
	let attemptedSave = $state(false);
	let saveIssues = $state<readonly FolderIssue[]>([]);
	let addIssues = $state<readonly FolderIssue[]>([]);
	let saveError = $state("");
	let picker = $state<{ focus: () => void }>();
	const isPhone = $derived(sessionViewState.compact);
	let viewportHeight = $state(0);
	let keyboardInset = $state(0);
	let saveVersion = 0;

	const original = $derived(createDraft(project));
	const setupValue = $derived(setupScript.trim() ? setupScript : "");
	const folderRoots = $derived(labelProjectFolders(draft.folders.map(folderPath)));
	const unsupportedProviders = $derived((instances ?? getAvailableInstances().map(({ id, label, capabilities }) => ({
		id, name: getInstanceById(id)?.name ?? label, capabilities,
	}))).filter((instance) => instance.capabilities?.supportsMultiFolder === false));
	const issues = $derived(check(draft, project ? projects.filter(({ slug }) => slug !== project.slug) : []));
	const permissionIssues = $derived(saveIssues.filter((issue) => issue.kind === "permission-denied"));
	const errors = $derived([
		...(draft.folders.length || attemptedSave ? issues.errors : []),
		...addIssues,
		...saveIssues.filter((issue) => issue.kind !== "permission-denied"),
	]);
	const canSave = $derived(
		!saving && issues.errors.length === 0 && !issues.nameError && (!project || isDirty(draft, original) || setupValue !== (project.setupScript ?? "") || sessionMode !== (project.sessionMode ?? "")),
	);

	onMount(() => {
		const viewport = window.visualViewport;
		function measure(): void {
			viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
			keyboardInset = Math.max(0, window.innerHeight - viewportHeight - (viewport?.offsetTop ?? 0));
		}
		measure();
		viewport?.addEventListener("resize", measure);
		viewport?.addEventListener("scroll", measure);
		window.addEventListener("resize", measure);
		return () => {
			viewport?.removeEventListener("resize", measure);
			viewport?.removeEventListener("scroll", measure);
			window.removeEventListener("resize", measure);
		};
	});

	$effect(() => {
		if (!open) {
			saveVersion++;
			return;
		}
		draft = original;
		setupScript = project?.setupScript ?? "";
		sessionMode = project?.sessionMode ?? "";
		addIssues = [];
		saveIssues = [];
		saveError = "";
		attemptedSave = false;
		gitInit = true;
		saving = false;
		void tick().then(() => {
			if (open) picker?.focus();
		});
	});

	function changed(next: ProjectDraft): void {
		draft = next;
		saveIssues = [];
		saveError = "";
		addIssues = [];
	}

	function changeFolders(next: ProjectDraft): void {
		changed(next);
		picker?.focus();
	}

	function toggleFolder(entry: FindFoldersResponse["entries"][number]): void {
		if (saving) return;
		if (draft.folders.some((folder) => folderPath(folder) === entry.path)) {
			changeFolders(removeFolder(draft, entry.path));
			return;
		}
		const result = addFolder(draft, entry.exists ? entry.path : { path: entry.path, create: { gitInit } });
		changeFolders(result.draft);
		addIssues = result.errors;
	}

	async function save(): Promise<void> {
		if (saving) return;
		attemptedSave = true;
		if (!canSave) return;
		const version = ++saveVersion;
		saving = true;
		saveIssues = [];
		saveError = "";
		try {
			const response = await saveProject({
				...(project ? { slug: project.slug } : {}),
				title: draft.name,
				folders: draft.folders,
				...(setupValue ? { setupScript: setupValue } : project?.setupScript ? { setupScript: "" } : {}),
				...(sessionMode ? { sessionMode } : project?.sessionMode ? { sessionMode: null } : {}),
			});
			if (!open || version !== saveVersion) return;
			onsaved?.(response);
			onclose();
		} catch (error) {
			if (!open || version !== saveVersion) return;
			if (error instanceof ProjectSaveRejected) saveIssues = error.issues;
			else saveError = failureLine(error, "Couldn't save the project. Try again.");
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
			case "permission-denied": return `Permission denied: ${issue.path}. Check the folder permissions and try again.`;
			case "not-a-folder": return `${issue.path} isn't a folder.`;
			case "conduit-worktree": return `${issue.path} belongs to a session worktree and cannot be added to a project.`;
			case "create-exists": return `${issue.path} already exists. Add it as an existing folder.`;
			case "mkdir-failed": return `Couldn't create ${issue.path}: ${issue.message}`;
			case "git-init-failed": return `Couldn't initialise git in ${issue.path}: ${issue.message}`;
			case "unknown-project": return `Project ${issue.slug} no longer exists.`;
			case "sessions-running": return `${issue.count} sessions are running. Save when they finish.`;
		}
	}
</script>

{#snippet sessionModeControl()}
	<Select bind:value={sessionMode} aria-label="Default session mode" title="Without a project override, conduit.json takes precedence over the global default." disabled={saving} touchTarget>
		<option value="">Use global default</option>
		<option value="local">Local folder</option>
		<option value="worktree">New worktree</option>
	</Select>
{/snippet}

<Dialog {open} {onclose} {returnFocus} labelledBy={titleId} describedBy={hintId} placement={isPhone ? "sheet" : "top"} dismissible={!saving}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<Surface
		variant="card"
		radius="none"
		elevation="modal"
		class="project-dialog flex w-[540px] max-w-[calc(100vw-24px)] flex-col gap-[14px] rounded-[16px] p-[18px] max-md:w-screen max-md:max-w-none max-md:gap-[9px] max-md:rounded-none max-md:border-x-0 max-md:p-[16px]"
		style={`max-height: ${isPhone ? `${viewportHeight}px` : "80dvh"}; ${isPhone ? `height: ${viewportHeight}px; transform: translateY(-${keyboardInset}px);` : ""}`}
		data-testid="project-dialog"
		onkeydown={handleKeydown}
	>
		<header class="flex shrink-0 items-start gap-[10px]">
			<div class="min-w-0 flex-1">
				<h2 id={titleId} class="text-[17px] font-semibold text-text">{project ? "Edit project" : "Add a project"}</h2>
				<p id={hintId} class="mt-[2px] text-[13px] text-text-secondary">Pick one or more folders. The first is the project's main folder.</p>
			</div>
			<Button variant="ghost" size="sm" iconOnly icon="x" iconSize={18} ariaLabel="Close" touchTarget disabled={saving} onclick={onclose} />
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
			<div class="flex flex-col gap-[9px]">
				<FolderPicker bind:this={picker} selectedPaths={draft.folders.map(folderPath)} ontoggle={toggleFolder} {findFolders} bind:gitInit disabled={saving} />
				{#if permissionIssues.length}<div role="alert" class="break-words text-[11px] text-error">{#each permissionIssues as issue}<p>{issueText(issue)}</p>{/each}</div>{/if}
				{#if draft.folders.length === 0}
					<p class="py-[12px] text-[12px] text-text-muted">No folders added yet</p>
				{:else}
					<ul aria-label="Project folders" class="flex flex-wrap gap-[6px]">
						{#each draft.folders as folder, index (folderPath(folder))}
							{@const path = folderPath(folder)}
							{@const label = folderRoots[index]?.label ?? path}
							{@const repository = project?.repositoryIdentities?.[path]}
							{@const git = project?.git?.folders?.find(({ root }) => root === path) ?? (path === project?.folders[0] && !project?.git?.folders ? project?.git : undefined)}
							<li data-testid="project-folder-chip" data-path={path} aria-label={`${index === 0 ? "Main" : "Extra"} folder: ${path}`}>
								<div class="flex min-h-[28px] max-w-full items-center gap-[6px] rounded-full bg-chip pl-[10px] pr-[6px] text-[13px] max-md:min-h-[44px]">
									<div class="min-w-0" title={path}>
										<span class="block truncate">{label}</span>
										{#if repository || git}
											<span class="block break-all text-[9px] text-text-muted">{repository?.name ?? label} · {git?.branch ?? (git?.head ? `Detached at ${git.head}` : "Branch unavailable")}</span>
										{:else if project?.folders.includes(path) && project.repositoryIdentities !== undefined}
											<span class="block text-[9px] text-text-muted">Not a git repository</span>
										{/if}
										{#if typeof folder !== "string" && folder.create.gitInit}<span class="text-[9px] text-text-muted">git init</span>{/if}
									</div>
									{#if typeof folder !== "string"}<Badge variant="quiet">new</Badge>{/if}
									{#if index === 0}<Badge variant="accent-solid">Main</Badge>{:else}<Button variant="ghost" size="content" ariaLabel={`Make main: ${path}`} class="text-[10px] text-text-muted max-md:min-h-[44px]" disabled={saving} onclick={() => changeFolders(makeMain(draft, path))}>Make main</Button>{/if}
									<Button variant="ghost" size="content" iconOnly icon="x" iconSize={12} class="h-[18px] w-[18px] max-md:h-[44px] max-md:w-[44px]" ariaLabel={`Remove folder: ${path}`} touchTarget disabled={saving} onclick={() => changeFolders(removeFolder(draft, path))} />
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				{#if draft.folders.length > 1 && unsupportedProviders.length > 0}
					<section aria-label="Provider folder support" data-testid="project-provider-capabilities" class="text-[11px] text-text-secondary">
						{#each unsupportedProviders as instance (instance.id)}
							<p>{instance.name} works in the main folder only.</p>
						{/each}
					</section>
				{/if}
				<Field label="Project name">
					<TextInput invalid={Boolean(issues.nameError)} aria-describedby={issues.nameError ? `${uid}-name-error` : undefined} placeholder="Project name" value={draft.name} disabled={saving} oninput={(event) => changed(rename(draft, event.currentTarget.value))} class="max-md:h-[44px] max-md:text-[16px]" />
				</Field>
				{#if isPhone}
					<Field label="Default session mode" hint="Without a project override, conduit.json takes precedence over the global default.">
						{@render sessionModeControl()}
					</Field>
				{/if}
				<Field label="Setup script" hint="It runs in each new worktree before the agent starts.">
					<Textarea bind:value={setupScript} rows={3} disabled={saving} spellcheck={false} autocapitalize="none" class="font-mono text-xs max-md:text-[16px]" />
				</Field>
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
		<footer class="flex shrink-0 items-center justify-end gap-[7px] pt-[2px] max-md:pb-[env(safe-area-inset-bottom)]">
			{#if !isPhone}
				<div class="mr-auto flex min-w-0 items-center gap-[8px]">
					<span class="shrink-0 text-[12.5px] text-text-muted">New sessions in</span>
					<div class="w-[160px] min-w-0">{@render sessionModeControl()}</div>
				</div>
			{/if}
			<Button variant="secondary" size="content" class="h-[34px] rounded-full px-[14px] text-[13.5px] font-medium max-md:min-h-[44px]" disabled={saving} onclick={onclose}>Cancel</Button>
			<Button variant="primary" size="content" ariaLabel={project ? "Save" : "Add project"} class="h-[34px] gap-[6px] rounded-full px-[14px] text-[13.5px] font-medium max-md:min-h-[44px]" loading={saving} disabled={!canSave} onclick={() => void save()}>{project ? "Save" : "Add project"} <span aria-hidden="true" class="font-mono text-[9px] max-md:hidden pointer-coarse:hidden">⌘↵</span></Button>
		</footer>
	</Surface>
</Dialog>

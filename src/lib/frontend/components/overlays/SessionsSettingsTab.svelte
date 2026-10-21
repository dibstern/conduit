<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import { Schema } from "effect";
	import { DefaultSessionModeSchema } from "../../../contracts/project-file.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { applyDefaultSessionMode, discoveryState } from "../../stores/discovery.svelte.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { PROJECT_TREE_ROWS, projectTreeState, setProjectTreeRows } from "../../stores/project-tree.svelte.js";
	import { DEFAULT_WORKTREE_CLEANUP, type ProjectWorktreeCleanup, type WorktreeCleanup, type WorktreeCleanupReport } from "../../../contracts/worktree.js";
	import Button from "../ui/Button.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	let state = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false, autoArchiveDays: 30 as number | null, autoArchiveSaving: false, autoDeleteDays: 30 as number | null, autoDeleteSaving: false, sessionModeSaving: false, cleanupGlobal: DEFAULT_WORKTREE_CLEANUP as WorktreeCleanup, cleanupOverride: null as ProjectWorktreeCleanup | null, cleanupScope: "global" as "global" | "project", cleanupLoaded: true, cleanupSaving: false, cleanupOpen: false, cleanupDetailsOpen: false, cleanupRun: { status: "idle" } as { status: "idle" | "running" | "failed" } | { status: "done"; report: WorktreeCleanupReport } });
	const cleanupProjectSlug = $derived.by(() => {
		const route = getCurrentRoute();
		return route.page === "chat" && route.draft ? getDraftProject() : getCurrentSlug();
	});
	const cleanupProject = $derived(projectState.projects.find((project) => project.slug === cleanupProjectSlug));
	const cleanupScope = $derived(cleanupProject ? state.cleanupScope : "global");
	const cleanupOff = $derived(cleanupScope === "project" && state.cleanupOverride === "off");
	const cleanup = $derived(cleanupScope === "project" && state.cleanupOverride !== null && state.cleanupOverride !== "off" ? state.cleanupOverride : state.cleanupGlobal);
	const cleanupDisabled = $derived(!state.cleanupLoaded || state.cleanupSaving || (cleanupScope === "project" && state.cleanupOverride === null));

	const idlePresets = [7, 14, 30, 90];
	const outcomes = [
		{ key: "removed", label: "Removed" },
		{ key: "kept", label: "Kept" },
		{ key: "failed", label: "Failed" },
	] as const;
	const keepNotes = {
		"any-local-files": { warning: false, text: "Includes ignored files, except node_modules." },
		"uncommitted-changes": { warning: true, text: "Ignored files, like .env or build output, are lost when a worktree is removed." },
		"tracked-changes": { warning: true, text: "Untracked and ignored files, like .env, are deleted when a worktree is removed." },
	} as const;
	const keepNote = $derived(keepNotes[cleanup.keepWhen]);
	const cleanupSummary = $derived.by(() => {
		if (cleanupOff) return "Off";
		const { onSettle, settledAfterDays, onDelete } = cleanup;
		const rules = [
			onSettle === "nothing-missing" ? "When nothing is missing" : undefined,
			settledAfterDays === null ? undefined : settledAfterDays === 0 ? "When settled" : `Settled ${settledAfterDays}+ days`,
			onDelete ? "When deleted" : undefined,
		].filter((rule) => rule !== undefined);
		return rules.length > 1 ? `${rules.length} rules` : (rules[0] ?? "Off");
	});

	function saveCleanup(change: Partial<WorktreeCleanup> | "off" | null): void {
		if (!state.cleanupLoaded || state.cleanupSaving) return;
		const previousGlobal = state.cleanupGlobal;
		const previousOverride = state.cleanupOverride;
		const projectSlug = cleanupScope === "project" ? cleanupProject?.slug : undefined;
		const next = change === null || change === "off" ? change : { ...cleanup, ...change };
		const input = projectSlug
			? { scope: "project" as const, projectSlug, override: next }
			: next !== null && next !== "off" ? { scope: "global" as const, rules: next } : undefined;
		if (!input) return;
		if (input.scope === "project") state.cleanupOverride = input.override;
		else state.cleanupGlobal = input.rules;
		state.cleanupSaving = true;
		void rpc("SetWorktreeCleanupSetting", input)
			.then((saved) => {
				state.cleanupGlobal = saved.global;
				if (projectSlug === cleanupProject?.slug) state.cleanupOverride = saved.project ?? null;
			})
			.catch((error) => {
				state.cleanupGlobal = previousGlobal;
				if (projectSlug === cleanupProject?.slug) state.cleanupOverride = previousOverride;
				toastFailure("Couldn't save worktree cleanup setting")(error);
			})
			.finally(() => {
				state.cleanupSaving = false;
			});
	}

	function cleanUpNow(): void {
		state.cleanupRun = { status: "running" };
		state.cleanupDetailsOpen = false;
		void rpc("CleanUpWorktreesNow", {})
			.then((report) => {
				state.cleanupRun = { status: "done", report };
			})
			.catch(() => {
				state.cleanupRun = { status: "failed" };
			});
	}

	$effect(() => {
		if (!getIsConnected()) return;
		const route = getCurrentRoute();
		if (route.page === "chat" && route.sessionId && !getCurrentSlug()) return;
		let current = true;
		void rpc("GetAutoDeleteArchivedSetting", {})
			.then(({ autoDeleteArchivedAfterDays: days }) => {
				if (current && !state.autoDeleteSaving) state.autoDeleteDays = days;
			})
			.catch((error) => {
				if (current) toastFailure("Couldn't load archived retention setting")(error);
			});
		void rpc("GetAutoArchiveSetting", {})
			.then(({ autoArchiveAfterDays: days }) => {
				if (current && !state.autoArchiveSaving) state.autoArchiveDays = days;
			})
			.catch((error) => {
				if (current) toastFailure("Couldn't load auto-archive setting")(error);
			});
		void rpc("GetAutoSettleSetting", {})
			.then(({ autoSettleAfterDays: days }) => {
				if (current && !state.autoSettleSaving) state.autoSettleDays = days;
			})
			.catch((error) => {
				if (current) toastFailure("Couldn't load auto-settle setting")(error);
			});
		return () => { current = false; };
	});

	$effect(() => {
		// Reload on reconnect or project change only; a save returns the saved rules.
		if (!getIsConnected()) return;
		const projectSlug = cleanupProject?.slug;
		let current = true;
		state.cleanupLoaded = false;
		void rpc("GetWorktreeCleanupSetting", projectSlug ? { projectSlug } : {}).then((setting) => {
			if (!current) return;
			// A save in flight returns the newer global rules; this project's override is still current.
			if (!state.cleanupSaving) state.cleanupGlobal = setting.global;
			state.cleanupOverride = setting.project ?? null;
			state.cleanupLoaded = true;
		}).catch((error) => {
			if (current) toastFailure("Couldn't load worktree cleanup setting")(error);
		});
		return () => { current = false; };
	});
</script>

<SettingsGroup id="settings-sessions" title="Sessions">
	<SettingsRow
		label="Default session mode"
		labelFor="settings-default-session-mode"
		description="Applies to new drafts. Last used repeats your previous new session. Project settings and conduit.json take precedence."
	>
		{#snippet control()}
			<SettingsPicker
				id="settings-default-session-mode"
				label="Default session mode"
				data-testid="settings-default-session-mode"
				value={discoveryState.defaultSessionMode}
				disabled={state.sessionModeSaving || !(getDraftProject() ?? getCurrentSlug())}
				onvaluechange={(mode) => {
					const projectSlug = getDraftProject() ?? getCurrentSlug();
					if (!projectSlug || !Schema.is(DefaultSessionModeSchema)(mode)) return;
					state.sessionModeSaving = true;
					void rpc("SetDefaultSessionMode", { projectSlug, mode })
						.then((response) => applyDefaultSessionMode(response.mode))
						.catch(toastFailure("Couldn't save default session mode"))
						.finally(() => { state.sessionModeSaving = false; });
				}}
				options={[{ value: "local", label: "Local" }, { value: "worktree", label: "New worktree" }, { value: "last", label: "Last used" }]}
			/>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Sessions per project"
		labelFor="settings-project-tree-rows"
		description="Shown under each project when the list is grouped by project, before Show more. On this device only."
	>
		{#snippet control()}
			<SettingsPicker label="Sessions per project"
				id="settings-project-tree-rows"
				data-testid="settings-project-tree-rows"
				value={String(projectTreeState.rows)}
				onvaluechange={(value) => setProjectTreeRows(Number(value))}
			 options={Array.from({ length: PROJECT_TREE_ROWS.max - PROJECT_TREE_ROWS.min + 1 }, (_, index) => ({ value: String(PROJECT_TREE_ROWS.min + index), label: String(PROJECT_TREE_ROWS.min + index) }))} />
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Settle idle sessions after"
		labelFor="settings-auto-settle-select"
		description="Moves idle sessions to the Settled shelf, where the worktree cleanup rules below apply."
	>
		{#snippet control()}
			<SettingsPicker
				id="settings-auto-settle-select"
				label="Settle idle sessions after"
				data-testid="settings-auto-settle-select"
				value={state.autoSettleDays === null ? "never" : String(state.autoSettleDays)}
				disabled={state.autoSettleSaving}
				onvaluechange={(value) => {
					const next = value === "never" ? null : Number(value);
					state.autoSettleSaving = true;
					void rpc("SetAutoSettleSetting", { autoSettleAfterDays: next })
						.then(({ autoSettleAfterDays: days }) => {
							state.autoSettleDays = days;
						})
						.catch(toastFailure("Couldn't save auto-settle setting"))
						.finally(() => {
							state.autoSettleSaving = false;
						});
				}}
				options={[{ value: "1", label: "1 day" }, { value: "2", label: "2 days" }, { value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "never", label: "Never" }]}
			/>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Archive settled sessions after"
		labelFor="settings-auto-archive-select"
		description="Hides them from the sidebar. Search still finds them."
	>
		{#snippet control()}
			<SettingsPicker id="settings-auto-archive-select" label="Archive settled sessions after" data-testid="settings-auto-archive-select"
				value={state.autoArchiveDays === null ? "never" : String(state.autoArchiveDays)}
				disabled={state.autoArchiveSaving}
				onvaluechange={(value) => {
					state.autoArchiveSaving = true;
					void rpc("SetAutoArchiveSetting", { autoArchiveAfterDays: value === "never" ? null : Number(value) })
						.then(({ autoArchiveAfterDays: days }) => { state.autoArchiveDays = days; })
						.catch(toastFailure("Couldn't save auto-archive setting"))
						.finally(() => { state.autoArchiveSaving = false; });
				}}
				options={[{ value: "1", label: "1 day" }, { value: "2", label: "2 days" }, { value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "never", label: "Never" }]}
			/>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Delete archived sessions"
		labelFor="settings-auto-delete-select"
		description="Permanently deletes them and their history after this long in the archive."
	>
		{#snippet control()}
			<SettingsPicker label="Delete archived sessions" id="settings-auto-delete-select" data-testid="settings-auto-delete-select"
				value={state.autoDeleteDays === null ? "never" : String(state.autoDeleteDays)}
				disabled={state.autoDeleteSaving}
				onvaluechange={(value) => {

					state.autoDeleteSaving = true;
					void rpc("SetAutoDeleteArchivedSetting", { autoDeleteArchivedAfterDays: value === "never" ? null : Number(value) })
						.then(({ autoDeleteArchivedAfterDays: days }) => { state.autoDeleteDays = days; })
						.catch(toastFailure("Couldn't save archived retention setting"))
						.finally(() => { state.autoDeleteSaving = false; });
				}}
			 options={[{ value: "1", label: "1 day" }, { value: "2", label: "2 days" }, { value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "never", label: "Never" }]} />
		{/snippet}
	</SettingsRow>
</SettingsGroup>

<SettingsGroup id="settings-worktree-cleanup" title="Worktree cleanup" collapsible bind:open={state.cleanupOpen} summary={cleanupSummary} testId="settings-worktree-cleanup">
	{#if cleanupProject}
		<SettingsRow label="Apply to" labelFor="settings-cleanup-scope">
			{#snippet control()}
				<SettingsPicker label="Apply to" id="settings-cleanup-scope" data-testid="settings-cleanup-scope" value={cleanupScope} disabled={state.cleanupSaving} onvaluechange={(value) => { state.cleanupScope = value === "project" ? "project" : "global"; }} options={[{ value: "global", label: "All projects" }, { value: "project", label: cleanupProject.title || cleanupProject.slug }]} />
			{/snippet}
		</SettingsRow>
	{/if}
	{#if cleanupScope === "project"}
		<SettingsRow label="Cleanup mode" labelFor="settings-cleanup-mode">
			{#snippet control()}
				<SettingsPicker label="Cleanup mode" id="settings-cleanup-mode" data-testid="settings-cleanup-mode" value={state.cleanupOverride === null ? "global" : state.cleanupOverride === "off" ? "off" : "custom"} disabled={!state.cleanupLoaded || state.cleanupSaving} onvaluechange={(value) => {
					const mode = value;
					saveCleanup(mode === "global" ? null : mode === "off" ? "off" : state.cleanupGlobal);
				}} options={[{ value: "global", label: "Use global" }, { value: "off", label: "Off" }, { value: "custom", label: "Custom" }]} />
			{/snippet}
		</SettingsRow>
	{/if}
	{#if cleanupOff}
		<p class="px-3 py-2 text-[11px] leading-[1.35] text-text-muted" data-testid="settings-cleanup-off">Nothing is removed automatically. Deleting a session asks first.</p>
	{:else}
	<p class="px-3 py-2 text-[11px] leading-[1.35] text-text-muted">
		Runs every hour, right after a session settles or is deleted, and when you change a rule or press Run. It skips sessions that are running, waiting on you, open in a tab or sharing a worktree, and worktrees with an open terminal. Branches are kept, so a removed worktree is rebuilt on the session's next message.
	</p>
	<SettingsRow label="When a session settles" labelFor="settings-cleanup-on-settle" description="Nothing is missing when every commit is already in the default branch and there are no uncommitted or untracked files. The branch is kept.">
		{#snippet control()}
			<SettingsPicker label="When a session settles" id="settings-cleanup-on-settle" data-testid="settings-cleanup-on-settle" value={cleanup.onSettle} disabled={cleanupDisabled} onvaluechange={(value) => {
				const onSettle = value;
				if (onSettle === "nothing-missing" || onSettle === "keep") saveCleanup({ onSettle });
			}} options={[{ value: "nothing-missing", label: "Remove if nothing is missing" }, { value: "keep", label: "Keep" }]} />
		{/snippet}
	</SettingsRow>
	<SettingsRow label="Remove settled worktrees after" labelFor="settings-cleanup-settled-after" description="Counted from when the session settled, even if its commits aren't merged. The branch is kept.">
		{#snippet control()}
			<SettingsPicker label="Remove settled worktrees after" id="settings-cleanup-settled-after" data-testid="settings-cleanup-settled-after" value={String(cleanup.settledAfterDays ?? "never")} disabled={cleanupDisabled} onvaluechange={(value) => {

				saveCleanup({ settledAfterDays: value === "never" ? null : Number(value) });
			}} options={[{ value: "never", label: "Never" }, { value: "0", label: "Right away" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, ...(cleanup.settledAfterDays !== null && cleanup.settledAfterDays !== 0 && !idlePresets.includes(cleanup.settledAfterDays) ? [{ value: String(cleanup.settledAfterDays), label: `${cleanup.settledAfterDays} days` }] : [])]} />
		{/snippet}
	</SettingsRow>
	<SettingsRow label="When a session is deleted" labelFor="settings-cleanup-on-delete" description="Ask lets you choose in the delete dialog.">
		{#snippet control()}
			<SettingsPicker label="When a session is deleted" id="settings-cleanup-on-delete" data-testid="settings-cleanup-on-delete" value={cleanup.onDelete ? "remove" : "ask"} disabled={cleanupDisabled} onvaluechange={(value) => saveCleanup({ onDelete: value === "remove" })} options={[{ value: "ask", label: "Ask" }, { value: "remove", label: "Remove" }]} />
		{/snippet}
	</SettingsRow>
	<div>
		<SettingsRow label="Keep worktrees with" labelFor="settings-cleanup-keep-when">
			{#snippet control()}
				<SettingsPicker label="Keep worktrees with" id="settings-cleanup-keep-when" data-testid="settings-cleanup-keep-when" value={cleanup.keepWhen} disabled={cleanupDisabled} onvaluechange={(keepWhen) => {
					if (keepWhen === "any-local-files" || keepWhen === "uncommitted-changes" || keepWhen === "tracked-changes") saveCleanup({ keepWhen });
				}} options={[{ value: "any-local-files", label: "Any local files" }, { value: "uncommitted-changes", label: "Uncommitted changes" }, { value: "tracked-changes", label: "Changes to tracked files" }]} />
			{/snippet}
		</SettingsRow>
		<p class="-mt-1 px-3 pb-2 text-[11px] leading-[1.35] {keepNote.warning ? 'text-warning' : 'text-text-muted'}" data-testid={keepNote.warning ? "settings-cleanup-keep-warning" : "settings-cleanup-keep-note"}>{keepNote.text}</p>
	</div>
	{/if}
	<div>
		<SettingsRow label="Clean up now">
			{#snippet control()}
				<Button variant="secondary" size="sm" touchTarget data-testid="settings-cleanup-run" disabled={state.cleanupRun.status === "running"} onclick={cleanUpNow}>{state.cleanupRun.status === "running" ? "Running…" : "Run"}</Button>
			{/snippet}
		</SettingsRow>
		<div aria-live="polite" data-testid="settings-cleanup-report">
			{#if state.cleanupRun.status === "failed"}
				<p role="alert" class="px-3 pb-2 text-[11px] text-error">Couldn't run cleanup. Try again.</p>
			{:else if state.cleanupRun.status === "done"}
				{@const report = state.cleanupRun.report}
				{#if report.removed.length + report.kept.length + report.failed.length === 0}
					<p class="px-3 pb-2 text-[11px] text-text-muted">No session worktrees to clean up.</p>
				{:else}
					<Disclosure look="card" density="compact" expanded={state.cleanupDetailsOpen} onToggle={() => (state.cleanupDetailsOpen = !state.cleanupDetailsOpen)} class="pb-2">
						<span data-testid="settings-cleanup-counts">
							{#each outcomes as outcome, index (outcome.key)}{index ? " · " : ""}<span class={outcome.key === "failed" && report.failed.length ? "text-error" : ""}>{outcome.label} {report[outcome.key].length}</span>{/each}
						</span>
					</Disclosure>
					{#if state.cleanupDetailsOpen}
						<div class="flex flex-col gap-2 px-3 pb-2 text-[11px]">
							{#each outcomes as outcome (outcome.key)}
								{#if report[outcome.key].length}
									<section aria-label={outcome.label}>
										<h4 class="font-medium text-text">{outcome.label}</h4>
										<ul class="mt-0.5 flex flex-col gap-1">
											{#each report[outcome.key] as entry (`${entry.projectSlug}:${entry.sessionId}:${entry.path}`)}
												<li data-testid="settings-cleanup-entry">
													<span class="block truncate text-text" title={entry.path}>{findSession(entry.sessionId)?.title || entry.path}</span>
													<span class="block text-text-muted">{entry.reason}</span>
												</li>
											{/each}
										</ul>
									</section>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
</SettingsGroup>

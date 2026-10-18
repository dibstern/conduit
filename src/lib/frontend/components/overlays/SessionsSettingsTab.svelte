<script lang="ts">
	import { untrack } from "svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Select from "../ui/Select.svelte";
	import { Schema } from "effect";
	import { GroupingModeSchema } from "../../../shared-types.js";
	import { DefaultSessionModeSchema } from "../../../contracts/project-file.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { getAutoSettleSettingRpc, setAutoSettleSettingRpc, getDefaultGroupingModeRpc, setDefaultGroupingModeRpc, setDefaultSessionModeRpc, getWorktreeCleanupSettingRpc, setWorktreeCleanupSettingRpc, cleanUpWorktreesNowRpc } from "../../transport/ws-rpc-client.js";
	import { applyDefaultSessionMode, discoveryState } from "../../stores/discovery.svelte.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { DEFAULT_WORKTREE_CLEANUP, type ProjectWorktreeCleanup, type WorktreeCleanup, type WorktreeCleanupReport } from "../../../contracts/worktree.js";
	import Button from "../ui/Button.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	let state = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false, sessionModeSaving: false, groupingSaving: false, cleanupGlobal: DEFAULT_WORKTREE_CLEANUP as WorktreeCleanup, cleanupOverride: null as ProjectWorktreeCleanup | null, cleanupScope: "global" as "global" | "project", cleanupLoaded: true, cleanupSaving: false, cleanupOpen: false, cleanupDetailsOpen: false, cleanupRun: { status: "idle" } as { status: "idle" | "running" | "failed" } | { status: "done"; report: WorktreeCleanupReport } });
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
		void setWorktreeCleanupSettingRpc(input)
			.then((saved) => {
				state.cleanupGlobal = saved.global;
				if (projectSlug === cleanupProject?.slug) state.cleanupOverride = saved.project ?? null;
			})
			.catch(() => {
				state.cleanupGlobal = previousGlobal;
				if (projectSlug === cleanupProject?.slug) state.cleanupOverride = previousOverride;
				showToast("Couldn't save worktree cleanup setting", { variant: "error" });
			})
			.finally(() => {
				state.cleanupSaving = false;
			});
	}

	function cleanUpNow(): void {
		state.cleanupRun = { status: "running" };
		state.cleanupDetailsOpen = false;
		void cleanUpWorktreesNowRpc()
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
		const groupingReadRevision = untrack(() => projectState.defaultGroupingRevision);
		void getAutoSettleSettingRpc()
			.then((days) => {
				if (current && !state.autoSettleSaving) state.autoSettleDays = days;
			})
			.catch(() => {
				if (current) showToast("Couldn't load auto-settle setting", { variant: "error" });
			});
		void getDefaultGroupingModeRpc()
			.then((mode) => {
				if (current && groupingReadRevision === projectState.defaultGroupingRevision) projectState.defaultGroupingMode = mode;
			})
			.catch(() => {
				if (current) showToast("Couldn't load grouping setting", { variant: "error" });
			});
		return () => { current = false; };
	});

	$effect(() => {
		// Reload on reconnect or project change only; a save returns the saved rules.
		if (!getIsConnected()) return;
		const projectSlug = cleanupProject?.slug;
		let current = true;
		state.cleanupLoaded = false;
		const read = projectSlug
			? getWorktreeCleanupSettingRpc(projectSlug)
			: getWorktreeCleanupSettingRpc().then((global) => ({ global, project: null }));
		void read.then((setting) => {
			if (!current) return;
			// A save in flight returns the newer global rules; this project's override is still current.
			if (!state.cleanupSaving) state.cleanupGlobal = setting.global;
			state.cleanupOverride = setting.project ?? null;
			state.cleanupLoaded = true;
		}).catch(() => {
			if (current) showToast("Couldn't load worktree cleanup setting", { variant: "error" });
		});
		return () => { current = false; };
	});
</script>

<SettingsGroup id="settings-sessions" title="Sessions">
	<SettingsRow label="Default repository grouping" labelFor="settings-grouping-mode-select" description="Projects inherit this unless they choose their own mode.">
		{#snippet control()}
			<Select id="settings-grouping-mode-select" value={projectState.defaultGroupingMode} disabled={state.groupingSaving} onchange={(event) => {
				const mode = event.currentTarget.value;
				if (!Schema.is(GroupingModeSchema)(mode)) return;
				const groupingSaveRevision = ++projectState.defaultGroupingRevision;
				state.groupingSaving = true;
				void setDefaultGroupingModeRpc(mode)
					.then((saved) => {
						if (groupingSaveRevision === projectState.defaultGroupingRevision) projectState.defaultGroupingMode = saved;
					})
					.catch(() => { showToast("Couldn't save grouping setting", { variant: "error" }); })
					.finally(() => { state.groupingSaving = false; });
			}}>
				<option value="repository">By repository</option>
				<option value="repository+subfolder">By repository and subfolder</option>
				<option value="off">Off</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Default session mode"
		labelFor="settings-default-session-mode"
		description="Applies to new drafts. Last used repeats your previous new session. Project settings and conduit.json take precedence."
	>
		{#snippet control()}
			<Select
				id="settings-default-session-mode"
				data-testid="settings-default-session-mode"
				value={discoveryState.defaultSessionMode}
				disabled={state.sessionModeSaving || !(getDraftProject() ?? getCurrentSlug())}
				onchange={(event) => {
					const mode = event.currentTarget.value;
					const projectSlug = getDraftProject() ?? getCurrentSlug();
					if (!projectSlug || !Schema.is(DefaultSessionModeSchema)(mode)) return;
					state.sessionModeSaving = true;
					void setDefaultSessionModeRpc({ projectSlug, mode })
						.then((response) => applyDefaultSessionMode(response.mode))
						.catch(() => showToast("Couldn't save default session mode", { variant: "error" }))
						.finally(() => { state.sessionModeSaving = false; });
				}}
			>
				<option value="local">Local</option>
				<option value="worktree">New worktree</option>
				<option value="last">Last used</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Settle idle sessions after"
		labelFor="settings-auto-settle-select"
		description="Moves idle sessions to the Settled shelf, where the worktree cleanup rules below apply."
	>
		{#snippet control()}
			<Select
				id="settings-auto-settle-select"
				data-testid="settings-auto-settle-select"
				value={state.autoSettleDays === null ? "never" : String(state.autoSettleDays)}
				disabled={state.autoSettleSaving}
				onchange={(event) => {
					const value = event.currentTarget.value;
					const next = value === "never" ? null : Number(value);
					state.autoSettleSaving = true;
					void setAutoSettleSettingRpc(next)
						.then((days) => {
							state.autoSettleDays = days;
						})
						.catch(() => {
							showToast("Couldn't save auto-settle setting", { variant: "error" });
						})
						.finally(() => {
							state.autoSettleSaving = false;
						});
				}}
			>
				<option value="1">1 day</option>
				<option value="2">2 days</option>
				<option value="3">3 days</option>
				<option value="7">1 week</option>
				<option value="14">2 weeks</option>
				<option value="30">30 days</option>
				<option value="90">90 days</option>
				<option value="never">Never</option>
			</Select>
		{/snippet}
	</SettingsRow>
</SettingsGroup>

<SettingsGroup id="settings-worktree-cleanup" title="Worktree cleanup" collapsible bind:open={state.cleanupOpen} summary={cleanupSummary} testId="settings-worktree-cleanup">
	{#if cleanupProject}
		<SettingsRow label="Apply to" labelFor="settings-cleanup-scope">
			{#snippet control()}
				<Select id="settings-cleanup-scope" data-testid="settings-cleanup-scope" value={cleanupScope} disabled={state.cleanupSaving} onchange={(event) => { state.cleanupScope = event.currentTarget.value === "project" ? "project" : "global"; }}>
					<option value="global">All projects</option>
					<option value="project">{cleanupProject.title || cleanupProject.slug}</option>
				</Select>
			{/snippet}
		</SettingsRow>
	{/if}
	{#if cleanupScope === "project"}
		<SettingsRow label="Cleanup mode" labelFor="settings-cleanup-mode">
			{#snippet control()}
				<Select id="settings-cleanup-mode" data-testid="settings-cleanup-mode" value={state.cleanupOverride === null ? "global" : state.cleanupOverride === "off" ? "off" : "custom"} disabled={!state.cleanupLoaded || state.cleanupSaving} onchange={(event) => {
					const mode = event.currentTarget.value;
					saveCleanup(mode === "global" ? null : mode === "off" ? "off" : state.cleanupGlobal);
				}}>
					<option value="global">Use global</option>
					<option value="off">Off</option>
					<option value="custom">Custom</option>
				</Select>
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
			<Select id="settings-cleanup-on-settle" data-testid="settings-cleanup-on-settle" value={cleanup.onSettle} disabled={cleanupDisabled} onchange={(event) => {
				const onSettle = event.currentTarget.value;
				if (onSettle === "nothing-missing" || onSettle === "keep") saveCleanup({ onSettle });
			}}>
				<option value="nothing-missing">Remove if nothing is missing</option>
				<option value="keep">Keep</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow label="Remove settled worktrees after" labelFor="settings-cleanup-settled-after" description="Counted from when the session settled, even if its commits aren't merged. The branch is kept.">
		{#snippet control()}
			<Select id="settings-cleanup-settled-after" data-testid="settings-cleanup-settled-after" value={String(cleanup.settledAfterDays ?? "never")} disabled={cleanupDisabled} onchange={(event) => {
				const value = event.currentTarget.value;
				saveCleanup({ settledAfterDays: value === "never" ? null : Number(value) });
			}}>
				<option value="never">Never</option>
				<option value="0">Right away</option>
				<option value="7">1 week</option>
				<option value="14">2 weeks</option>
				<option value="30">30 days</option>
				<option value="90">90 days</option>
				{#if cleanup.settledAfterDays !== null && cleanup.settledAfterDays !== 0 && !idlePresets.includes(cleanup.settledAfterDays)}
					<option value={String(cleanup.settledAfterDays)}>{cleanup.settledAfterDays} days</option>
				{/if}
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow label="When a session is deleted" labelFor="settings-cleanup-on-delete" description="Ask lets you choose in the delete dialog.">
		{#snippet control()}
			<Select id="settings-cleanup-on-delete" data-testid="settings-cleanup-on-delete" value={cleanup.onDelete ? "remove" : "ask"} disabled={cleanupDisabled} onchange={(event) => saveCleanup({ onDelete: event.currentTarget.value === "remove" })}>
				<option value="ask">Ask</option>
				<option value="remove">Remove</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<div>
		<SettingsRow label="Keep worktrees with" labelFor="settings-cleanup-keep-when">
			{#snippet control()}
				<Select id="settings-cleanup-keep-when" data-testid="settings-cleanup-keep-when" value={cleanup.keepWhen} disabled={cleanupDisabled} onchange={(event) => {
					const keepWhen = event.currentTarget.value;
					if (keepWhen === "any-local-files" || keepWhen === "uncommitted-changes" || keepWhen === "tracked-changes") saveCleanup({ keepWhen });
				}}>
					<option value="any-local-files">Any local files</option>
					<option value="uncommitted-changes">Uncommitted changes</option>
					<option value="tracked-changes">Changes to tracked files</option>
				</Select>
			{/snippet}
		</SettingsRow>
		<p class="-mt-1 px-3 pb-2 text-[11px] leading-[1.35] {keepNote.warning ? 'text-warning' : 'text-text-muted'}" data-testid={keepNote.warning ? "settings-cleanup-keep-warning" : "settings-cleanup-keep-note"}>{keepNote.text}</p>
	</div>
	{/if}
	<div>
		<SettingsRow label="Clean up now">
			{#snippet control()}
				<Button variant="secondary" size="sm" data-testid="settings-cleanup-run" disabled={state.cleanupRun.status === "running"} onclick={cleanUpNow}>{state.cleanupRun.status === "running" ? "Running…" : "Run"}</Button>
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

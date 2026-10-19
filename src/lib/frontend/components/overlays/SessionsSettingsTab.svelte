<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Select from "../ui/Select.svelte";
	import { Schema } from "effect";
	import { DefaultSessionModeSchema } from "../../../contracts/project-file.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { applyDefaultSessionMode, discoveryState } from "../../stores/discovery.svelte.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { DEFAULT_WORKTREE_CLEANUP, type WorktreeCleanup, type WorktreeCleanupReport } from "../../../contracts/worktree.js";
	import Button from "../ui/Button.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	let state = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false, autoArchiveDays: 30 as number | null, autoArchiveSaving: false, sessionModeSaving: false, cleanup: DEFAULT_WORKTREE_CLEANUP as WorktreeCleanup, cleanupSaving: false, cleanupOpen: false, cleanupDetailsOpen: false, cleanupRun: { status: "idle" } as { status: "idle" | "running" | "failed" } | { status: "done"; report: WorktreeCleanupReport } });

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
	const keepNote = $derived(keepNotes[state.cleanup.keepWhen]);
	const cleanupSummary = $derived.by(() => {
		const { onSettle, whenMerged, afterInactiveDays, noCommitsBeyondDefault, onDelete } = state.cleanup;
		const rules = [
			onSettle === "merged" ? "Settled and merged" : onSettle === "any" ? "When settled" : undefined,
			whenMerged ? "When merged" : undefined,
			afterInactiveDays === null ? undefined : `Idle ${afterInactiveDays}+ days`,
			noCommitsBeyondDefault ? "No new commits" : undefined,
			onDelete ? "When deleted" : undefined,
		].filter((rule) => rule !== undefined);
		return rules.length > 1 ? `${rules.length} rules` : (rules[0] ?? "Off");
	});

	function saveCleanup(patch: Partial<WorktreeCleanup>): void {
		const previous = state.cleanup;
		const next = { ...previous, ...patch };
		state.cleanup = next;
		state.cleanupSaving = true;
		void rpc("SetWorktreeCleanupSetting", { worktreeCleanup: next })
			.then(({ worktreeCleanup: saved }) => {
				state.cleanup = saved;
			})
			.catch((error) => {
				state.cleanup = previous;
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
		void rpc("GetWorktreeCleanupSetting", {})
			.then(({ worktreeCleanup: cleanup }) => {
				if (current && !state.cleanupSaving) state.cleanup = cleanup;
			})
			.catch((error) => {
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
					void rpc("SetDefaultSessionMode", { projectSlug, mode })
						.then((response) => applyDefaultSessionMode(response.mode))
						.catch(toastFailure("Couldn't save default session mode"))
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
		description="Moves to the Settled shelf. Nothing is deleted."
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
					void rpc("SetAutoSettleSetting", { autoSettleAfterDays: next })
						.then(({ autoSettleAfterDays: days }) => {
							state.autoSettleDays = days;
						})
						.catch(toastFailure("Couldn't save auto-settle setting"))
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
	<SettingsRow
		label="Archive settled sessions after"
		labelFor="settings-auto-archive-select"
		description="Hides them from the sidebar. Search still finds them."
	>
		{#snippet control()}
			<Select id="settings-auto-archive-select" data-testid="settings-auto-archive-select"
				value={state.autoArchiveDays === null ? "never" : String(state.autoArchiveDays)}
				disabled={state.autoArchiveSaving}
				onchange={(event) => {
					const value = event.currentTarget.value;
					state.autoArchiveSaving = true;
					void rpc("SetAutoArchiveSetting", { autoArchiveAfterDays: value === "never" ? null : Number(value) })
						.then(({ autoArchiveAfterDays: days }) => { state.autoArchiveDays = days; })
						.catch(toastFailure("Couldn't save auto-archive setting"))
						.finally(() => { state.autoArchiveSaving = false; });
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
	<p class="px-3 py-2 text-[11px] leading-[1.35] text-text-muted">
		Runs every hour, right after a session settles or is deleted, and when you change a rule or press Run. It skips sessions that are running, waiting on you, open in a tab or sharing a worktree, and worktrees with an open terminal. Branches are kept, so a removed worktree is rebuilt on the session's next message.
	</p>
	<SettingsRow label="When a session settles" labelFor="settings-cleanup-on-settle" description="Merged means its branch is in the default branch.">
		{#snippet control()}
			<Select id="settings-cleanup-on-settle" data-testid="settings-cleanup-on-settle" value={state.cleanup.onSettle} disabled={state.cleanupSaving} onchange={(event) => {
				const onSettle = event.currentTarget.value;
				if (onSettle === "merged" || onSettle === "any" || onSettle === "off") saveCleanup({ onSettle });
			}}>
				<option value="merged">Remove if merged</option>
				<option value="any">Remove</option>
				<option value="off">Keep</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow label="When a session is deleted" labelFor="settings-cleanup-on-delete" description="Ask lets you choose in the delete dialog.">
		{#snippet control()}
			<Select id="settings-cleanup-on-delete" data-testid="settings-cleanup-on-delete" value={state.cleanup.onDelete ? "remove" : "ask"} disabled={state.cleanupSaving} onchange={(event) => saveCleanup({ onDelete: event.currentTarget.value === "remove" })}>
				<option value="ask">Ask</option>
				<option value="remove">Remove</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow label="Remove idle worktrees after" labelFor="settings-cleanup-idle" description="Settled or not, counted from the session's last activity.">
		{#snippet control()}
			<Select id="settings-cleanup-idle" data-testid="settings-cleanup-idle" value={String(state.cleanup.afterInactiveDays ?? "never")} disabled={state.cleanupSaving} onchange={(event) => {
				const value = event.currentTarget.value;
				saveCleanup({ afterInactiveDays: value === "never" ? null : Number(value) });
			}}>
				{#if state.cleanup.afterInactiveDays !== null && !idlePresets.includes(state.cleanup.afterInactiveDays)}
					<option value={String(state.cleanup.afterInactiveDays)}>{state.cleanup.afterInactiveDays} days</option>
				{/if}
				<option value="7">1 week</option>
				<option value="14">2 weeks</option>
				<option value="30">30 days</option>
				<option value="90">90 days</option>
				<option value="never">Never</option>
			</Select>
		{/snippet}
	</SettingsRow>
	<SettingsRow label="Remove once merged" description="Settled or not, as soon as its branch is in the default branch." checked={state.cleanup.whenMerged} disabled={state.cleanupSaving} onchange={() => saveCleanup({ whenMerged: !state.cleanup.whenMerged })} />
	<SettingsRow label="Remove if its branch has no new commits" description="Settled or not. Covers sessions that committed nothing, like a quick question." checked={state.cleanup.noCommitsBeyondDefault} disabled={state.cleanupSaving} onchange={() => saveCleanup({ noCommitsBeyondDefault: !state.cleanup.noCommitsBeyondDefault })} />
	<div>
		<SettingsRow label="Keep worktrees with" labelFor="settings-cleanup-keep-when">
			{#snippet control()}
				<Select id="settings-cleanup-keep-when" data-testid="settings-cleanup-keep-when" value={state.cleanup.keepWhen} disabled={state.cleanupSaving} onchange={(event) => {
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

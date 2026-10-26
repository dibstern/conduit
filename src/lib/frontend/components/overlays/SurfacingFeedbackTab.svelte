<script lang="ts">
	import { untrack } from "svelte";
	import { Schema } from "effect";
	import { CategorySetRejected, surfacingLevel, type CategorySet, type SurfacingFeedbackEntry } from "../../../contracts/category-set.js";
	import type { CategoryTuningHunk, CategoryTuningScore, CategoryTuningProposal } from "../../../contracts/category-tuning.js";
	import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";
	import { feedbackLedger, MARK_GLYPHS } from "../../stores/surfacing-feedback.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { changedAgreement, hunkDependencies, hunkDiff, movedMessages, withTuningHunks } from "../../utils/category-tuning.js";
	import { SURFACE_LABELS } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	import CategoryPill from "../ui/CategoryPill.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Icon from "../ui/Icon.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import SettingsBanner from "../ui/SettingsBanner.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";

	const LEVELS = { ...SURFACE_LABELS, hidden: "hidden" };
	let { active, onApplied }: { active: boolean; onApplied: () => void } = $props();
	let entries = $state<readonly SurfacingFeedbackEntry[]>([]);
	let current = $state<CategorySet | null>(null);
	let score = $state<CategoryTuningScore | null>(null);
	let proposal = $state<CategoryTuningProposal | null>(null);
	let avoiding = $state<readonly CategoryTuningHunk[]>([]);
	let selected = $state<readonly string[]>([]);
	let hunkScores = $state<Record<string, CategoryTuningScore | "failed">>({});
	let candidate = $state<CategoryTuningScore | null>(null);
	let loading = $state(true);
	let proposing = $state(false);
	let saving = $state(false);
	let testing = $state<string | null>(null);
	let clearing = $state<string | null>(null);
	let error = $state("");
	let proposalError = $state("");
	let notice = $state("");
	let stale = $state(false);
	let loaded = false;
	let scoreRequest = 0;
	let reviewRequest = 0;
	const chosen = $derived(proposal?.hunks.filter((hunk) => selected.includes(hunk.id)) ?? []);
	const dependencies = $derived(Object.fromEntries((proposal?.hunks ?? []).map((hunk) => [hunk.id, hunkDependencies(proposal?.hunks ?? [], hunk)])));
	const counts = $derived.by(() => {
		const rows = (current?.categories ?? []).map((category) => ({ category, raise: 0, lower: 0, retype: 0 }));
		for (const entry of entries) {
			const answer = surfacingLevel(entry, current ?? { categories: [] });
			const row = rows.find(({ category }) => category.id === answer.category);
			if (row && entry.mark.direction) row[entry.mark.direction]++;
		}
		return rows.filter((row) => row.raise + row.lower + row.retype > 0);
	});
	const mostRaised = $derived([...counts].sort((a, b) => b.raise - a.raise)[0]);
	const mostLowered = $derived([...counts].sort((a, b) => b.lower - a.lower)[0]);
	const raised = $derived(entries.filter((entry) => entry.mark.direction === "raise").length);
	const lowered = $derived(entries.filter((entry) => entry.mark.direction === "lower").length);
	const retyped = $derived(entries.filter((entry) => entry.mark.direction === "retype").length);

	$effect(() => {
		if (active) untrack(() => { if (!proposal && !proposing) void load(); });
	});
	$effect(() => {
		const review = proposal;
		const hunks = chosen;
		const base = current;
		if (!review || !base || stale) return;
		const request = ++reviewRequest;
		candidate = null;
		void rpc("ScoreCategorySet", { set: withTuningHunks(base, hunks), estimateOnly: true }).then((result) => {
			if (request === reviewRequest) candidate = result;
		}).catch(() => { if (request === reviewRequest) proposalError = "Could not preview the selected changes. Try again."; });
		return () => { reviewRequest++; };
	});

	async function load(): Promise<void> {
		loading = !loaded;
		error = "";
		try {
			const [ledger, set] = await Promise.all([rpc("GetSurfacingLedger", {}), rpc("GetCategorySet", {})]);
			entries = ledger;
			current = set;
			loaded = true;
			score = await rpc("ScoreCategorySet", { set, estimateOnly: true });
		} catch { error = "Could not load feedback. Try again."; }
		finally { loading = false; }
	}
	async function clear(entry: SurfacingFeedbackEntry): Promise<void> {
		if (clearing || proposing || saving) return;
		clearing = entry.partId;
		error = "";
		try {
			await rpc("SetSurfacingMark", { sessionId: entry.sessionId, partId: entry.partId, mark: null });
			feedbackLedger.entries = feedbackLedger.entries.filter((item) => item.sessionId !== entry.sessionId || item.partId !== entry.partId);
			proposal = null;
			notice = "";
			await load();
		} catch { error = "Could not clear the mark. Try again."; }
		finally { clearing = null; }
	}
	async function propose(): Promise<void> {
		if (entries.length < 5 || proposing || saving || clearing || testing) return;
		const avoid = proposal?.hunks.filter((hunk) => !selected.includes(hunk.id)) ?? [];
		avoiding = avoid;
		proposing = true;
		proposalError = "";
		notice = "";
		stale = false;
		try {
			const result = await rpc("ProposeCategoryTuning", { avoid });
			const set = await rpc("GetCategorySet", {});
			if (set.version !== result.baseVersion) {
				proposal = null;
				await load();
				proposalError = "Categories changed while Opus was proposing. Review the current set and propose again.";
				return;
			}
			current = set;
			score = await rpc("ScoreCategorySet", { set, estimateOnly: true });
			proposal = result;
			selected = result.hunks.map((hunk) => hunk.id);
			hunkScores = {};
			hunkScores = await scoreHunks(set, result.hunks);
		} catch (cause) { proposalError = failureLine(cause, "Opus could not propose changes. Try again."); }
		finally { proposing = false; }
	}
	async function testChanges(id: string, estimateOnly = false): Promise<void> {
		if (!current || !proposal || testing || stale) return;
		const hunks = id === "selected" ? chosen : proposal.hunks.filter((hunk) => hunk.id === id || dependencies[id]?.some((other) => other.id === hunk.id));
		const request = ++scoreRequest;
		testing = id;
		proposalError = "";
		try {
			const result = await rpc("ScoreCategorySet", { set: withTuningHunks(current, hunks), estimateOnly });
			if (request !== scoreRequest) return;
			if (id === "selected") candidate = result;
			else hunkScores = { ...hunkScores, [id]: result };
			if (estimateOnly) return;
			// All weight variants share the verdict cache. Refresh the costs and
			// evidence together after an explicit test fills it.
			const [combined, individual] = await Promise.all([
				rpc("ScoreCategorySet", { set: withTuningHunks(current, chosen), estimateOnly: true }),
				scoreHunks(current, proposal.hunks),
			]);
			if (request !== scoreRequest) return;
			candidate = combined;
			hunkScores = individual;
		} catch {
			if (request !== scoreRequest) return;
			if (estimateOnly) hunkScores = { ...hunkScores, [id]: "failed" };
			else proposalError = "Could not score the changes. Your proposal is still here.";
		}
		finally { if (request === scoreRequest) testing = null; }
	}
	/** Each hunk is scored with the retirements it needs; one failed score keeps the others. */
	async function scoreHunks(set: CategorySet, hunks: readonly CategoryTuningHunk[]): Promise<Record<string, CategoryTuningScore | "failed">> {
		const results = await Promise.allSettled(hunks.map((hunk) => rpc("ScoreCategorySet", { set: withTuningHunks(set, [...hunkDependencies(hunks, hunk), hunk]), estimateOnly: true })));
		return Object.fromEntries(hunks.map((hunk, index) => {
			const result = results[index];
			return [hunk.id, result?.status === "fulfilled" ? result.value : "failed"];
		}));
	}
	function tick(hunk: CategoryTuningHunk, checked: boolean): void {
		selected = checked
			? [...new Set([...selected, hunk.id, ...(dependencies[hunk.id] ?? []).map(({ id }) => id)])]
			: selected.filter((id) => id !== hunk.id && !dependencies[id]?.some((other) => other.id === hunk.id));
	}
	function dismiss(): void {
		scoreRequest++;
		reviewRequest++;
		proposal = null;
		candidate = null;
		hunkScores = {};
		selected = [];
		avoiding = [];
		proposalError = "";
		stale = false;
	}
	async function apply(): Promise<void> {
		if (!current || !proposal || !chosen.length || saving || stale || testing) return;
		saving = true;
		proposalError = "";
		try {
			const set = await rpc("ReplaceCategorySet", { expectedVersion: proposal.baseVersion, nextSet: withTuningHunks(current, chosen) });
			messageSurfacing.categorySet = set;
			dismiss();
			notice = "Applied. The category set moved to the next version. Weight changes re-level at once; criteria changes apply from the next judged message.";
			onApplied();
			await load();
		} catch (cause) {
			if (Schema.is(CategorySetRejected)(cause) && cause.reason === "stale_version") {
				stale = true;
				await load();
				proposalError = "Categories changed elsewhere. The current set has been reloaded. Propose again before applying.";
			} else proposalError = failureLine(cause, "Could not apply changes. Your proposal is still here.");
		} finally { saving = false; }
	}
</script>

{#if loading}<p role="status">Loading feedback…</p>
{:else}
	{#if error}<div role="alert" class="mb-3 flex flex-col items-start gap-2"><SettingsBanner tone="danger">{error}</SettingsBanner><Button variant="settings" size="content" onclick={() => { void load(); }}>Retry</Button></div>{/if}
	{#if notice}<p role="status" class="mb-3 text-[12.5px] text-success">{notice}</p>{/if}
	{#if current}
		{#if proposing}
			<div class="prop run" data-testid="surfacing-proposal-status">
				<ConduitMark size={14} variant="running" />
				<div class="min-w-0" role="status"><span>✦ Reading {entries.length} marks and {current?.categories.length} categories…</span>
					{#if avoiding.length}<small>Avoiding: {avoiding.map((hunk) => `${hunk.after.label} ${hunkDiff(hunk).map((change) => change.field).join(", ")}`).join("; ")}</small>{/if}
				</div>
			</div>
		{:else if proposal?.hunks.length}
			<div data-testid="surfacing-proposal-review">
				{#if proposalError}<SettingsBanner role="alert" tone="warning" class="mt-[14px]">{proposalError}</SettingsBanner>{/if}
				<div class="rhd" data-testid="surfacing-proposal-summary">
					<b>✦ Opus proposes {proposal.hunks.length} {proposal.hunks.length === 1 ? "change" : "changes"}</b>
					{#if score?.complete && candidate?.complete}<span>Agrees with <b>{score.agree} → {candidate.agree}</b> of {candidate.total} corrections · moves {movedMessages(score, candidate)} messages</span>{/if}
					{#if proposal.rationale}<span>{proposal.rationale}</span>{/if}
				</div>
				<SettingsGroup id="surfacing-proposal-hunks">
					{#each proposal.hunks as hunk (hunk.id)}
						{@const estimate = hunkScores[hunk.id]}
						{@const result = estimate === "failed" ? undefined : estimate}
						{@const evidence = result?.complete && score?.complete ? changedAgreement(entries, score, result) : []}
						<div class="hunk" data-testid={`surfacing-proposal-hunk-${hunk.id}`}>
							<Checkbox variant="settings" aria-label={`Include ${hunk.after.label} change`} checked={selected.includes(hunk.id)} disabled={saving || testing !== null || stale} onchange={(event) => tick(hunk, event.currentTarget.checked)} />
							<div class="min-w-0 break-words"><CategoryPill category={hunk.after} plain />{#if !hunk.before}{" "}<ins>+ new category</ins>{/if}
								{#each hunkDiff(hunk).filter((change) => hunk.before || !["Add category", "colour"].includes(change.field)) as change, index}{index ? " · " : " "}{#if change.field === "weight" || change.field === "active"}{change.field === "weight" ? "weight " : ""}{:else}<code>{change.field}</code>{" "}{/if}{#if change.before}<del>{change.before}</del>{" → "}{/if}<ins>{change.before ? (change.after || "removed") : change.field === "weight" ? change.after : `+ ${change.after}`}</ins>{/each}
							</div>
							{#if estimate === "failed"}<Button variant="settings" size="content" data-testid={`surfacing-proposal-retry-${hunk.id}`} disabled={testing !== null || saving || stale} onclick={() => { void testChanges(hunk.id, true); }}>{testing === hunk.id ? "Estimating…" : "Retry estimate"}</Button>
							{:else if result && result.requiredCalls > 0}<Button variant="settings" size="content" data-testid={`surfacing-proposal-test-${hunk.id}`} disabled={testing !== null || saving || stale || !result.canTest} onclick={() => { void testChanges(hunk.id); }}>{testing === hunk.id ? "Testing…" : `Test · ${result.requiredCalls} Jev calls`}</Button>
							{:else if result?.complete}<em>free to score</em>
							{:else}<em></em>{/if}
							<p>{hunk.rationale}
								{#if dependencies[hunk.id]?.length}<br />Needs {dependencies[hunk.id]?.map((other) => `${other.after.label} retired`).join(", ")} to stay within 20 active.{/if}
								{#if estimate === "failed"}<br /><span role="alert">Could not estimate these changes.</span>
								{:else if result && !result.complete}<br /><span class="text-text-dimmer">{result.unavailableReason ?? "Test these criteria to see which corrections they fix or break."}</span>{/if}
							</p>
							{#if result?.complete && score?.complete}
								<div class="ev"><em>Agreement {score.agree} → {result.agree} / {result.total}</em>{#each evidence as item}<span class={item.fixed ? "y" : "n"} title={`${item.fixed ? "Fixes" : "Breaks"} #${item.entry.ordinal ?? "?"} · ${item.entry.sessionTitle}: ${item.entry.text}`}>#{item.entry.ordinal ?? "?"} {item.fixed ? "✓" : "✗"}</span>{/each}</div>
							{/if}
						</div>
					{/each}
				</SettingsGroup>
				{#if candidate && !candidate.complete && candidate.requiredCalls > 0}
					<div class="mt-[8px] flex flex-wrap items-center gap-x-3 gap-y-2 px-[4px] text-[12px] leading-[1.45] text-text-dimmer">
						<span class="min-w-0 flex-1">Criteria changes can't be scored until Jev re-judges the sample, which costs {candidate.requiredCalls} Jev calls.</span>
						<Button variant="settings" size="content" disabled={testing !== null || saving || stale || !candidate.canTest} onclick={() => { void testChanges("selected"); }}>Test selected · {candidate.requiredCalls} Jev calls</Button>
					</div>
				{/if}
				<div class="sticky bottom-0 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-settings-bg p-[10px] text-[12.5px] text-text-secondary ring-1 ring-border shadow-settings-dialog">
					<span class="min-w-0 flex-1 max-md:basis-full"><b class="font-semibold text-text">Unticked</b> changes are avoided next time.</span>
					<Button variant="ghost" size="sm" data-testid="surfacing-proposal-dismiss" disabled={saving || testing !== null} onclick={dismiss}>Dismiss</Button>
					<Button variant="settings" size="content" data-testid="surfacing-proposal-again" disabled={saving || testing !== null || entries.length < 5} onclick={() => { void propose(); }}>Propose again</Button>
					<Button size="content" variant="settings" tone="accent" data-testid="surfacing-proposal-apply" disabled={saving || testing !== null || stale || !chosen.length} onclick={() => { void apply(); }}>Apply {chosen.length} {chosen.length === 1 ? "change" : "changes"}</Button>
				</div>
			</div>
		{:else}
			{#if entries.length}
				<div class="tiles" data-testid="surfacing-feedback-tiles">
					<div><small>Marks</small><b>{entries.length}</b><span>{raised} ▲ · {lowered} ▼ · {retyped} ⇄</span></div>
					<div><small>Agreement now</small><b>{score?.complete ? `${score.agree} / ${score.total}` : "Unavailable"}</b><span>Jev vs your marks</span></div>
					<div><small>Most raised</small>{#if mostRaised?.raise}<b><CategoryPill category={mostRaised.category} plain /></b><span>{mostRaised.raise} ▲</span>{:else}<b>None yet</b>{/if}</div>
					<div><small>Most lowered</small>{#if mostLowered?.lower}<b><CategoryPill category={mostLowered.category} plain /></b><span>{mostLowered.lower} ▼</span>{:else}<b>None yet</b>{/if}</div>
				</div>
				{#if score && !score.complete}<p class="mt-2 px-[4px] text-[12px] text-text-dimmer">{score.unavailableReason ?? "Some messages have not been judged. Set a valid TypeSafe key in General to test criteria changes."}</p>{/if}
			{/if}
			<div class="prop" data-testid="surfacing-proposal-status">
				{#if proposalError}
					<SettingsBanner role="alert" tone="warning" class="w-full">{proposalError}</SettingsBanner>
					<Button variant="settings" size="content" onclick={() => { void propose(); }}>Retry</Button>
				{:else if proposal}
					<p role="status"><b class="font-semibold text-text">No changes suggested.</b> {proposal.rationale}</p>
					<div class="flex gap-2"><Button variant="ghost" size="sm" onclick={dismiss}>Dismiss</Button><Button variant="settings" size="content" onclick={() => { void propose(); }}>Propose again</Button></div>
				{:else}
					<Button variant="settings" tone="accent" size="content" disabled={entries.length < 5 || clearing !== null} onclick={() => { void propose(); }}><span aria-hidden="true">✦</span> Propose changes</Button>
					<span>{entries.length < 5 ? `Raise or lower a few messages and Opus can propose fixes. ${entries.length} / 5 marks.` : "Opus reads your marks and the category set, and proposes edits. Nothing changes until you apply."}</span>
				{/if}
			</div>
			{#if counts.length}
				<SettingsGroup id="surfacing-feedback-grid" title="Jev said → you said">
					<table class="grid-table" data-testid="surfacing-feedback-grid"><thead><tr><th>Category</th><th>▲ raised</th><th>▼ lowered</th><th>⇄ retyped</th></tr></thead><tbody>
						{#each counts as row (row.category.id)}<tr><td><CategoryPill category={row.category} plain /></td>{#each [row.raise, row.lower, row.retype] as count}<td class:z={!count}>{count}</td>{/each}</tr>{/each}
					</tbody></table>
				</SettingsGroup>
			{/if}
			{#if entries.length}
				<SettingsGroup id="surfacing-feedback-records" title="Marks">
					{#each entries as entry (`${entry.sessionId}:${entry.partId}`)}
						{@const answer = surfacingLevel(entry, current)}
						{@const category = current.categories.find((item) => item.id === answer.category)}
						{@const retype = entry.mark.category ? current.categories.find((item) => item.id === entry.mark.category) : undefined}
						{@const agreement = score?.levels.find((item) => item.partId === entry.partId && item.sessionId === entry.sessionId)?.level}
						{@const jev = entry.probabilities === null ? "Not judged" : `${category ? `${category.glyph} ${category.label} · p ${(entry.probabilities[category.id] ?? 0).toFixed(2).replace(/^0/, "")}` : "Routine"} · ${LEVELS[answer.level]}`}
						{@const you = `${entry.mark.direction ? `${MARK_GLYPHS[entry.mark.direction]} ` : ""}${entry.mark.category ? `${retype ? `${retype.glyph} ${retype.label}` : entry.mark.category} at ` : ""}${LEVELS[entry.mark.level]}${entry.mark.reason ? ` · “${entry.mark.reason}”` : ""}`}
						<div class="rec" data-testid="surfacing-ledger-record">
							<div title={entry.text}><b>#{entry.ordinal ?? "?"}</b> {entry.text || "Message unavailable"}</div>
							<small>{entry.sessionTitle} · <time datetime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></small>
							<small title={`Jev: ${jev} → you: ${you}`}>Jev: {#if entry.probabilities === null}Not judged{:else}{#if category}{#if category.origin === "builtin"}<CategoryPill {category} plain />{:else}{category.glyph} {category.label}{/if} · p {(entry.probabilities[category.id] ?? 0).toFixed(2).replace(/^0/, "")}{:else}Routine{/if} · {LEVELS[answer.level]}{/if} → you: {entry.mark.direction ? `${MARK_GLYPHS[entry.mark.direction]} ` : ""}{#if entry.mark.category}{#if retype}{#if retype.origin === "builtin"}<CategoryPill category={retype} plain />{:else}{retype.glyph} {retype.label}{/if}{:else}{entry.mark.category}{/if}{" at "}{/if}{LEVELS[entry.mark.level]}{entry.mark.reason ? ` · “${entry.mark.reason}”` : ""}{#if agreement != null}{" · "}<span class={agreement === entry.mark.level ? "text-success" : "text-error"}>current set {agreement === entry.mark.level ? "agrees" : "disagrees"}</span>{/if}</small>
							<Button variant="ghost" size="sm" class="col-start-2 row-span-3 row-start-1 self-center" disabled={clearing !== null || saving || proposing || testing !== null} onclick={() => { void clear(entry); }} ariaLabel={`Clear mark ${entry.ordinal ?? entry.partId}`}>Clear</Button>
						</div>
					{/each}
				</SettingsGroup>
			{/if}
		{/if}
	{/if}
{/if}

<style>
	.prop { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 16px; padding: 14px; border-radius: 12px; background: var(--color-settings-card); font-size: 13px; line-height: 1.45; color: var(--color-text-secondary); }
	.prop:first-child { margin-top: 0; }
	.prop.run { flex-direction: row; align-items: center; gap: 12px; }
	.prop small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-text-dimmer); }
	.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
	.tiles > div { min-width: 0; padding: 10px; border-radius: 12px; background: var(--color-settings-card); }
	.tiles small { display: block; font-size: 11.5px; color: var(--color-text-dimmer); }
	.tiles b { display: flex; margin-top: 3px; overflow: hidden; font-size: 15px; font-weight: 600; color: var(--color-text); white-space: nowrap; }
	.tiles > div > span { display: block; margin-top: 2px; overflow: hidden; font-size: 11.5px; color: var(--color-text-dimmer); white-space: nowrap; text-overflow: ellipsis; }
	@media (max-width: 767px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	.grid-table { width: calc(100% - 28px); margin: 2px 14px 6px; border-collapse: collapse; table-layout: fixed; font-size: 13px; color: var(--color-text); }
	.grid-table th, .grid-table td { height: 30px; padding: 0; text-align: right; }
	.grid-table th { font-size: 11.5px; font-weight: 400; color: var(--color-text-dimmer); }
	.grid-table td { font: 12.5px var(--font-mono); font-variant-numeric: tabular-nums; }
	.grid-table :is(th, td):first-child { text-align: left; font: inherit; }
	.grid-table th:first-child { font-size: 11.5px; }
	.grid-table th:not(:first-child) { width: 84px; }
	.grid-table .z { color: var(--color-text-dimmer); }
	@media (max-width: 767px) { .grid-table th:not(:first-child) { width: 64px; } }
	.rec { display: grid; color: var(--color-text); grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 9px 8px 9px 14px; font-size: 13px; }
	.rec > :is(div, small) { grid-column: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rec small { font-size: 11.5px; color: var(--color-text-dimmer); }
	/* Phones keep the verdict line whole so "current set agrees" is never cut off. */
	@media (max-width: 767px) { .rec > small:last-of-type { white-space: normal; } }
	.rec b { font-weight: 600; }
	.rhd { display: flex; flex-direction: column; gap: 2px; margin: 14px 4px 8px; font-size: 12.5px; line-height: 1.45; color: var(--color-text-secondary); }
	.rhd > b { font-size: 14px; font-weight: 600; color: var(--color-text); }
	.rhd span b { font-weight: 600; color: var(--color-text); }
	.hunk { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 14px; font-size: 13px; line-height: 1.45; color: var(--color-text); }
	.hunk > p, .hunk > .ev { grid-column: 2 / -1; margin: 0; }
	.hunk > p { font-size: 12px; color: var(--color-text-secondary); }
	.hunk em { font: 11px var(--font-mono); font-style: normal; color: var(--color-text-dimmer); white-space: nowrap; }
	.hunk del { color: var(--color-error); }
	.hunk ins { text-decoration: none; color: var(--color-success); }
	.hunk code { font: 11.5px var(--font-mono); color: var(--color-text-secondary); }
	.hunk :is(del, ins) { white-space: pre-wrap; }
	.ev { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
	.ev em { margin-right: 3px; }
	.ev span { padding: 0 6px; border-radius: 999px; font: 500 11px/18px var(--font-mono); }
	.ev .y { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
	.ev .n { background: color-mix(in srgb, var(--color-error) 14%, transparent); color: var(--color-error); }
</style>

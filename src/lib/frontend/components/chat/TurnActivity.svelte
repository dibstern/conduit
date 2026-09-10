<!-- ─── Turn Activity ───────────────────────────────────────────────────────── -->
<!-- Everything the model did for one prompt, collapsed to two lines: a summary   -->
<!-- sentence over a strip where each segment is a step (colour = kind of work,    -->
<!-- width = how long it took), with the turn's bill on the strip's line.          -->
<!--                                                                              -->
<!-- Hovering a segment captions it in place of the sentence; clicking one opens   -->
<!-- the full log at that step. While live the header counts up and the last few   -->
<!-- steps show as a ticker, so the work is visible without expanding anything.    -->
<script lang="ts">
	import { tick } from "svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";
	import Icon from "../shared/Icon.svelte";
	import {
		countsPhrase,
		currentStepLabel,
		economics,
		fmtDuration,
		stepCaption,
		stepDurations,
		type Turn,
		turnDuration,
		turnStats,
	} from "../../utils/turns.js";
	import ActivityRow from "./ActivityRow.svelte";
	import ActivityStrip from "./ActivityStrip.svelte";
	import TurnEconomics from "./TurnEconomics.svelte";

	let { turn }: { turn: Turn } = $props();

	let expanded = $state(false);
	let hovered = $state<number | null>(null);
	let focusUuid = $state<string | null>(null);
	let panelEl = $state<HTMLDivElement | undefined>();

	/** Only a live turn needs a clock; a settled one reads its stamps. */
	let now = $state(Date.now());
	$effect(() => {
		if (!turn.live) return;
		now = Date.now();
		const id = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	const stats = $derived(turnStats(turn.activity));
	const duration = $derived(turnDuration(turn, now));
	const durations = $derived(stepDurations(turn, now));
	const bill = $derived(economics(turn, now));
	const TICKER_ROWS = 3;
	const ticker = $derived(turn.activity.slice(-TICKER_ROWS));

	async function jumpTo(i: number) {
		const part = turn.activity[i];
		if (!part) return;
		expanded = true;
		focusUuid = part.uuid;
		await tick();
		panelEl?.querySelector(`[data-part="${part.uuid}"]`)?.scrollIntoView({ block: "nearest" });
	}
</script>

<div class="max-w-[760px] mx-auto px-5 my-1.5">
	<div
		bind:this={panelEl}
		class="rounded-panel {turn.live ? 'bg-bg-surface glow-tool-running' : 'border border-border-subtle'}"
	>
		<!-- The two summary lines are their own query container so the ledger sheds
		     detail against its own width, not the viewport's — a sidebar narrows the
		     transcript on a wide screen. Scoped to the summary so `container-type`'s
		     containment never reaches the expanded log's interactive cards. -->
		<div class="@container">
			<div class="flex items-center gap-3 py-1.5 pl-2 pr-3 text-xs">
				<button
					type="button"
					class="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
					aria-expanded={expanded}
					onclick={() => (expanded = !expanded)}
				>
					<span
						class="shrink-0 text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
						class:rotate-90={expanded}
					>
						<Icon name="chevron-right" size={14} />
					</span>
					{#if hovered !== null}
						<span class="flex-1 truncate font-mono text-text-secondary">{stepCaption(turn, hovered, now)}</span>
					{:else if turn.live}
						<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
						<span class="shrink-0 font-medium text-text-secondary @max-[336px]:hidden">Working</span>
						{#if duration !== undefined}
							<span class="shrink-0 font-mono text-text-dimmer">{fmtDuration(duration)}</span>
						{/if}
						<span class="flex-1 truncate text-text-muted">— {currentStepLabel(turn)}</span>
					{:else}
						<!-- Duration leads, so truncation eats the step counts from the right
						     and the one number that is always true survives. -->
						<span class="flex-1 truncate text-text-dimmer">
							<span class="font-medium text-text-secondary">
								Worked{duration !== undefined ? ` for ${fmtDuration(duration)}` : ""}
							</span>
							· {countsPhrase(stats)}
						</span>
					{/if}
				</button>
				{#if stats.failed > 0}
					<span class="shrink-0 text-error">{stats.failed} failed</span>
				{/if}
			</div>

			<div class="flex items-center gap-3 px-3 pb-2">
				<div class="flex-1 min-w-0">
					<ActivityStrip {turn} {now} active={hovered} onhover={(i) => (hovered = i)} onjump={jumpTo} />
				</div>
				<TurnEconomics economics={bill} />
			</div>
		</div>

		{#if expanded}
			<div class="px-1 pb-1 border-t border-border-subtle">
				{#each turn.activity as part, i (part.uuid)}
					<ActivityRow {part} duration={durations?.[i]} highlight={part.uuid === focusUuid} />
				{/each}
			</div>
		{:else if turn.live && !turn.reply}
			<!-- The ticker folds away the moment the reply starts streaming, so the
			     turn reaches its settled height once rather than twice. -->
			<div class="px-1 pb-1 border-t border-border-subtle">
				{#each ticker as part, i (part.uuid)}
					{@const idx = turn.activity.length - ticker.length + i}
					<div style="opacity: {(0.35 + (0.65 * (i + 1)) / ticker.length).toFixed(2)}">
						<ActivityRow {part} duration={durations?.[idx]} />
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- ─── Activity Strip ──────────────────────────────────────────────────────── -->
<!-- One segment per step: colour is the kind of work, width is how long it took. -->
<!-- Hovering reports the step up so the header can caption it; clicking jumps to  -->
<!-- it in the expanded log. Supplementary — every segment is also a row below.    -->
<!-- A compaction is a fixed-width seam rather than a weighted block: it marks    -->
<!-- where the context was squeezed, and took no share of the work.                -->
<!-- An emphasis set dims every other step, so a breakdown can point at its steps.  -->
<!--                                                                              -->
<!-- Touch only gets the tap: it opens the log at the step you hit, which is the   -->
<!-- useful half of the interaction anyway. Captioning is deliberately gated to a  -->
<!-- mouse — a tap fires `pointerenter` with no matching leave, so an ungated      -->
<!-- caption would replace the summary sentence and stay there.                    -->
<script lang="ts">
	import {
		type ActivityPart,
		fmtDuration,
		partLabel,
		stepDurations,
		stepWeights,
		type Segment,
		type Turn,
	} from "../../utils/turns.js";
	import { segmentClass } from "./activity-style.js";

	let {
		turn,
		segment,
		final,
		now,
		active = null,
		emphasis = null,
		height = "h-1.5",
		onhover,
		onjump,
	}: {
		turn: Turn;
		segment: Segment;
		final: boolean;
		now: number;
		/** Segment to highlight — owned by the parent so the caption can't drift. */
		active?: number | null;
		/** Steps to pick out while the rest recede, e.g. the skills in a breakdown. */
		emphasis?: ReadonlySet<number> | null;
		height?: string;
		onhover?: (i: number | null) => void;
		onjump?: (i: number) => void;
	} = $props();

	const weights = $derived(stepWeights(segment, turn, final, now));
	const durations = $derived(stepDurations(segment, turn, final, now));

	/** Roving tabindex: the strip is one tab stop, arrows scrub within it. */
	let cursor = $state(0);

	function title(part: ActivityPart, i: number): string {
		const d = part.type === "system" ? undefined : durations?.[i];
		return d === undefined ? partLabel(part) : `${partLabel(part)} · ${fmtDuration(d)}`;
	}

	function onKeyDown(e: KeyboardEvent & { currentTarget: HTMLElement }, i: number) {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		// Don't let the transcript scroll while scrubbing.
		e.preventDefault();
		e.stopPropagation();
		const n = segment.activity.length;
		cursor = (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
		onhover?.(cursor);
		const next = e.currentTarget.parentElement?.children[cursor];
		if (next instanceof HTMLElement) next.focus();
	}
</script>

<div
	class="flex {height} gap-px rounded-full overflow-hidden bg-bg-surface"
	role="group"
	aria-label="Activity timeline — {segment.activity.length} steps"
	onpointerleave={() => onhover?.(null)}
	onfocusout={() => onhover?.(null)}
>
	{#each segment.activity as part, i (part.uuid)}
		<button
			type="button"
			class="h-full cursor-pointer touch-manipulation transition-opacity outline-none focus-visible:ring-1 focus-visible:ring-brand-b {segmentClass(part)} {part.type === 'system'
				? 'compaction-seam shrink-0 w-0.5 mx-px'
				: `min-w-0.5 ${active === i || emphasis?.has(i) ? 'opacity-100' : emphasis ? 'opacity-20 hover:opacity-100' : 'opacity-60 hover:opacity-100'}`}"
			style={part.type === "system" ? undefined : `flex-grow: ${weights[i] ?? 1}`}
			title={title(part, i)}
			aria-label={title(part, i)}
			tabindex={i === Math.min(cursor, segment.activity.length - 1) ? 0 : -1}
			onkeydown={(e) => onKeyDown(e, i)}
			onfocus={() => {
				// Keep the tab stop where focus actually is, so leaving and returning
				// to the strip resumes from the last segment rather than the first.
				cursor = i;
				onhover?.(i);
			}}
			onpointerenter={(e) => {
				if (e.pointerType === "mouse") onhover?.(i);
			}}
			onclick={() => onjump?.(i)}
		></button>
	{/each}
</div>

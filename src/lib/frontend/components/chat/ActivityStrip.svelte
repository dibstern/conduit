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
		stripLayout,
		type Segment,
		type Turn,
	} from "../../utils/turns.js";
	import { segmentAppearance } from "./activity-style.js";
	import ActivityTimeline from "../ui/ActivityTimeline.svelte";

	let {
		turn,
		segment,
		final,
		now,
		running,
		active = null,
		emphasis = null,
		onhover,
		onjump,
		interactive = true,
	}: {
		turn: Turn;
		segment: Segment;
		final: boolean;
		now: number;
		/** Live tasks the turn launched: their launching steps keep breathing. */
		running: ReadonlySet<string>;
		/** Segment to highlight — owned by the parent so the caption can't drift. */
		active?: number | null;
		/** Steps to pick out while the rest recede, e.g. the skills in a breakdown. */
		emphasis?: ReadonlySet<number> | null;
		onhover?: (i: number | null) => void;
		onjump?: (i: number) => void;
		interactive?: boolean;
	} = $props();

	const positions = $derived(stripLayout(segment, turn, final, now));
	const durations = $derived(stepDurations(segment, turn, final, now));
	const segments = $derived(segment.activity.map((part, index) => {
		return {
			id: part.uuid,
			left: positions[index]?.left ?? 0,
			width: positions[index]?.width ?? 0,
			label: title(part, index),
			...segmentAppearance(part, running),
		};
	}));

	function title(part: ActivityPart, i: number): string {
		const duration = part.type === "system" ? undefined : durations?.[i];
		return duration === undefined ? partLabel(part) : `${partLabel(part)} · ${fmtDuration(duration)}`;
	}

</script>

<ActivityTimeline {segments} {active} {emphasis} {onhover} {onjump} {interactive} />

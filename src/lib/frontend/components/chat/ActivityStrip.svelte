<!-- One segment per step: colour is the kind of work, width is how long it took. -->
<!-- Hovering reports the step up so the header can caption it; clicking jumps to  -->
<!-- it in the expanded log. Supplementary — every segment is also a row below.    -->
<!-- A compaction is a fixed-width seam rather than a weighted block: it marks    -->
<!-- where the context was squeezed, and took no share of the work.                -->
<!--                                                                              -->
<!-- Touch only gets the tap: it opens the log at the step you hit, which is the   -->
<!-- useful half of the interaction anyway. Captioning is deliberately gated to a  -->
<!-- mouse — a tap fires `pointerenter` with no matching leave, so an ungated      -->
<!-- caption would replace the summary sentence and stay there.                    -->
<script lang="ts">
	import type { ComponentProps, Snippet } from "svelte";
	import type { SurfacePin, SurfacePart } from "../../utils/surface-turn.js";
	import { logSteps } from "../../utils/turn-stops.js";
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

	let { turn, segment, final, now, running, width = $bindable(0), active = null, markers, cardSlot, card, openAsk, belowLevel, cited, preview, sliderText, oninteraction, onpick, onjump, oncommand, phone = false }: {
		turn: Turn;
		segment: Segment;
		final: boolean;
		now: number;
		running: ReadonlySet<string>;
		width?: number;
		active?: string | null;
		markers?: ComponentProps<typeof ActivityTimeline>["markers"];
		cardSlot?: ComponentProps<typeof ActivityTimeline>["cardSlot"];
		card?: Snippet;
		openAsk?: SurfacePart | null;
		belowLevel?: boolean;
		cited?: string | null;
		preview?: Snippet<[SurfacePin]>;
		sliderText?: string;
		oninteraction?: ComponentProps<typeof ActivityTimeline>["oninteraction"];
		onpick?: (pin: SurfacePin) => void;
		onjump?: (id: string) => void;
		oncommand?: (event: KeyboardEvent) => void;
		phone?: boolean;
	} = $props();

	const positions = $derived(stripLayout(segment, turn, final, now, width));
	const durations = $derived(stepDurations(segment, turn, final, now));
	const steps = $derived(logSteps(turn));
	const segments = $derived(steps.map((part) => {
		const index = segment.activity.findIndex((candidate) => candidate.uuid === part.uuid);
		return {
			id: part.uuid,
			left: positions[index]?.left ?? 0,
			width: positions[index]?.width ?? 0,
			label: title(part, index),
			...segmentAppearance(part, running),
		};
	}));

	const seams = $derived(segment.activity.flatMap((part, index) => part.type === "system" ? [{ id: part.uuid, left: positions[index]?.left ?? 0, width: positions[index]?.width ?? 0 }] : []));

	function title(part: ActivityPart, i: number): string {
		const duration = part.type === "system" ? undefined : durations?.[i];
		return duration === undefined ? partLabel(part) : `${partLabel(part)} · ${fmtDuration(duration)}`;
	}

</script>

<ActivityTimeline {segments} {seams} bind:width {active} {markers} {cardSlot} {card} {openAsk} {belowLevel} {cited} {preview} {sliderText} {oninteraction} {onpick} {onjump} {oncommand} {phone} />

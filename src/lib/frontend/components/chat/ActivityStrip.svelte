<!-- Each segment is a step: colour names the work, width shows its duration.
     Mouse hover describes that step; touch only opens its log row.
     Compactions are fixed-width seams, with no share of the work. -->
<script lang="ts">
	import type { ComponentProps, Snippet } from "svelte";
	import type { SurfacePin, SurfacePart } from "../../utils/surface-turn.js";
	import { surfaceTime } from "../../utils/surface-turn.js";
	import {
		type ActivityPart,
		fmtDuration,
		isHandBack,
		partLabel,
		toolVerb,
		toolSubject,
		stepDurations,
		stripLayout,
		type Segment,
		type Turn,
	} from "../../utils/turns.js";
	import { partStyle, segmentAppearance } from "./activity-style.js";
	import ActivityTimeline from "../ui/ActivityTimeline.svelte";
	import Icon from "../ui/Icon.svelte";
	type TimelineProps = ComponentProps<typeof import("../ui/ActivityTimeline.svelte").default>;

	let { turn, segment, final, now, running, width = $bindable(0), active = null, markers, cardSlot, card, openAsk, belowLevel, cited, preview, sliderText, oninteraction, onpick, onjump, oncommand, phone = false }: {
		turn: Turn;
		segment: Segment;
		final: boolean;
		now: number;
		running: ReadonlySet<string>;
		width?: number;
		active?: string | null;
		markers?: TimelineProps["markers"];
		cardSlot?: TimelineProps["cardSlot"];
		card?: Snippet | undefined;
		openAsk?: SurfacePart | null;
		belowLevel?: boolean;
		cited?: string | null;
		preview?: Snippet<[SurfacePin]>;
		sliderText?: string;
		oninteraction?: TimelineProps["oninteraction"];
		onpick?: (pin: SurfacePin) => void;
		onjump?: (id: string) => void;
		oncommand?: (event: KeyboardEvent) => void;
		phone?: boolean;
	} = $props();

	const positions = $derived(stripLayout(segment, turn, final, now, width));
	const durations = $derived(stepDurations(segment, turn, final, now));
	const steps = $derived(segment.activity.filter((part) => part.type !== "system"));
	const segments = $derived(segment.activity.flatMap((part, index) => {
		if (part.type === "system") return [];
		return [{
			id: part.uuid,
			kind: part.type === "assistant" ? "message" as const : "step" as const,
			left: positions[index]?.left ?? 0,
			width: positions[index]?.width ?? 0,
			label: title(part, index),
			...segmentAppearance(part, running, final && turn.live && index === segment.activity.length - 1),
		}];
	}));

	const seams = $derived(segment.activity.flatMap((part, index) => part.type === "system" ? [{ id: part.uuid, left: positions[index]?.left ?? 0, width: positions[index]?.width ?? 0 }] : []));
	const handBacks = $derived(segment.activity.flatMap((part, index) => part.type === "tool" && isHandBack(part) ? [{ id: part.uuid, x: (positions[index]?.left ?? 0) + (positions[index]?.width ?? 0) / 2, label: part.name === "ExitPlanMode" ? "Plan approval" : "Question" }] : []));

	function title(part: ActivityPart, i: number): string {
		const duration = part.type === "system" ? undefined : durations?.[i];
		return duration === undefined ? partLabel(part) : `${partLabel(part)} · ${fmtDuration(duration)}`;
	}

</script>

{#snippet stepPreview(id: string)}
	{@const index = steps.findIndex((part) => part.uuid === id)}
	{@const part = steps[index]}
	{@const appearance = segments[index]}
	{#if part && appearance}
		{@const style = partStyle(part)}
		{@const duration = appearance.running && part.createdAt !== undefined ? Math.max(0, now - part.createdAt) : durations?.[segment.activity.findIndex((candidate) => candidate.uuid === id)]}
		<div class="flex items-center gap-[7px] text-[12px]">
			<Icon name={style.icon} size={14} class={appearance.tone === "fail" ? "text-seg-fail" : appearance.running ? "text-accent" : style.text} />
			<span class="shrink-0">{appearance.running ? "Running" : part.type === "tool" ? toolVerb(part) : part.type === "thinking" ? "Thought" : partLabel(part)}</span>
			{#if part.type === "tool"}<code class="min-w-0 truncate font-mono text-text-secondary">{toolSubject(part)}</code>{/if}
			{#if duration !== undefined}<span class="shrink-0 font-mono text-text-muted">{fmtDuration(duration)}{appearance.running ? " so far" : ""}</span>{/if}
			{#if appearance.tone === "fail"}<span class="text-seg-fail">failed</span>{/if}
			<span class="ml-auto shrink-0 font-mono text-text-muted">{surfaceTime((part.createdAt ?? 0) - (turn.user?.createdAt ?? segment.activity[0]?.createdAt ?? 0))}</span>
		</div>
		<div class="mt-[5px] text-[10.5px] text-text-dimmer">Step {index + 1}{turn.live ? "" : ` of ${steps.length}`} · click to open it in the log</div>
	{/if}
{/snippet}

<ActivityTimeline {segments} {seams} {handBacks} bind:width {active} {markers} {cardSlot} {card} {openAsk} {belowLevel} {cited} {preview} {stepPreview} {sliderText} {oninteraction} {onpick} {onjump} {oncommand} {phone} />

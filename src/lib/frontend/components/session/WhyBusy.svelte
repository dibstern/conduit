<!--
  Why busy (82tn.56): the busy indicator's glyph and spoken label, opening Session Activity's one
  answer with the open tool calls under it. A popover on desktop, a sheet on a phone.
-->
<script lang="ts">
	import type { WhyBusy, WhyBusyReason } from "../../../session/why-busy.js";
	import { clock } from "../../stores/clock.svelte.js";
	import type { SessionAttention } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Popover from "../ui/Popover.svelte";
	import SessionStatusGlyph from "../ui/SessionStatusGlyph.svelte";
	import { taskAge } from "./background-tasks.svelte.js";
	import { ATTENTION_DISPLAY } from "./SessionItem.svelte";

	let { attention, view }: { attention: SessionAttention; view: WhyBusy } = $props();

	const spoken = $derived(ATTENTION_DISPLAY[attention].spoken);
	const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
	const age = (since: number | undefined) => (since === undefined ? undefined : taskAge({ firstSeenAt: since }, clock.now));

	const headline = (reason: WhyBusyReason): string => {
		switch (reason.kind) {
			case "needs-you":
				return `${[reason.approvals > 0 ? plural(reason.approvals, "approval") : "", reason.questions > 0 ? plural(reason.questions, "question") : ""].filter(Boolean).join(", ")} waiting on you`;
			case "run":
				return reason.origin === "wake" ? `Woke up for ${reason.task ?? "a background task"}` : "Answering your message";
			case "background":
				return reason.activity === "work" ? "Background work running" : reason.activity === "serving" ? "Serving" : "Watching in the background";
			case "checking":
				return "Checking background tasks";
			case "members":
				return "A side thread or subagent is busy";
		}
	};
</script>

<Popover presentation="auto" ariaLabel="Why this session is busy" align="start" class="w-[300px] max-w-[calc(100vw-16px)] p-[12px] text-[12px]" data-testid="why-busy">
	{#snippet trigger({ props })}
		<Button {...props} variant="ghost" size="phone-status" touchTarget="always" class="shrink-0 gap-[5px]" ariaLabel={`${spoken}: why?`} data-testid="why-busy-trigger" data-attention={attention}>
			<SessionStatusGlyph {attention} size={14} />
			<span class="desktop-state-label text-[12px] text-text-secondary">{spoken}</span>
		</Button>
	{/snippet}
	<ul class="flex flex-col gap-[8px]" aria-label="Reasons">
		{#each view.reasons as reason (reason.kind)}
			<li data-testid="why-busy-reason" data-kind={reason.kind}>
				<div class="font-semibold text-text">{headline(reason)}</div>
				{#if reason.kind === "run" && reason.queued > 0}
					<div class="text-text-secondary" data-testid="why-busy-queued">{plural(reason.queued, "message")} queued behind it</div>
				{:else if reason.kind === "background" || reason.kind === "checking"}
					{#each reason.kind === "background" ? [...reason.tasks, ...reason.servers] : reason.stale as item, index (index)}
						<div class="flex gap-[8px] text-text-secondary" class:opacity-60={reason.kind === "checking"} data-testid="why-busy-item">
							<span class="min-w-0 flex-1 truncate">{item.label}</span>
							{#if age(item.since)}<span class="tabular-nums">{age(item.since)}</span>{/if}
						</div>
					{/each}
				{/if}
			</li>
		{/each}
	</ul>
	{#if view.tools.length > 0}
		<div class="mt-[10px] border-t border-border pt-[8px]">
			<div class="text-text-dimmer">Open tool calls</div>
			{#each view.tools as call (call.callId)}
				<div class="flex gap-[8px] text-text-secondary" data-testid="why-busy-tool">
					<span class="min-w-0 flex-1 truncate font-mono">{call.tool}</span>
					{#if age(call.since)}<span class="tabular-nums">{age(call.since)}</span>{/if}
				</div>
			{/each}
		</div>
	{/if}
</Popover>

<!--
  HandoffDialog — what a switch to another Claude account carries over, from
  the same budget the handoff itself uses, so the message count is the real one.

  With `confirm` it is the step before a manual switch: a swap card from the
  limited account to the chosen one, and Switch and continue. Without it, it is
  the read-only "What carried over?" behind a continuation divider, with a
  single Close. A modal on desktop, a bottom sheet with condensed rows on phones.
-->
<script lang="ts">
	import type { HandoffSummary, QuotaCheckResult } from "../../../contracts/limit-recovery.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { handoffMessagesLine, quotaReading } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import Surface from "../ui/Surface.svelte";

	let {
		open,
		onclose,
		to,
		summary,
		confirm,
	}: {
		open: boolean;
		onclose: () => void;
		/** The account the conversation is handed to. */
		to: string;
		/** null when nothing has been handed over yet (read-only only). */
		summary: HandoffSummary | null;
		/** Present for the confirm step before a manual switch. */
		confirm?:
			| {
					from: string;
					quota: QuotaCheckResult | undefined;
					/** Whether a cut-off request goes out with the handoff. */
					cutOff: boolean;
					busy: boolean;
					onconfirm: () => void;
			  }
			| undefined;
	} = $props();

	const titleId = $props.id();
	const compact = $derived(sessionViewState.compact);
	const nameOf = (instanceId: string) => getInstanceById(instanceId)?.name ?? instanceId;

	// Each row is its words and an optional dim aside.
	const rows = $derived.by((): { carries: [string, string?][]; drops: [string, string?][] } => {
		if (summary === null) return { carries: [], drops: [] };
		const messages = handoffMessagesLine(summary, compact);
		return compact
			? {
					carries: [[messages], ["Command output, errors, files, plans"], ["Older messages on request"]],
					drops: [["Reasoning, tool calls, diffs, attachments"], ["Prompt cache", "slower first reply"]],
				}
			: {
					carries: [
						[messages],
						["Command output and errors"],
						["Files touched, plans and the working directory"],
						["Model, mode and session settings"],
						["Older or oversized messages", "Claude can read them on request"],
					],
					drops: [
						["Thinking / reasoning blocks"],
						["Other tool calls, search results and diffs"],
						["Attachments and images"],
						["Prompt cache", "first reply is slower and uses more quota"],
						["Running subagents and background tasks"],
					],
				};
	});

	const buttonClass = $derived(
		compact ? "h-[34px] flex-1 justify-center rounded-[10px] px-[10px] text-[12px]" : "h-[24px] rounded-[8px] px-[10px] text-[11px]",
	);
</script>

{#snippet row(mark: "✓" | "✕", [text, aside]: [string, string?], testid: string | undefined)}
	<li class="relative py-[3px] pl-[18px] text-[11px] leading-[1.35]">
		<span aria-hidden="true" class="absolute left-0 {mark === '✓' ? 'text-success' : 'text-error'}">{mark}</span><span data-testid={testid}>{text}</span>{#if aside}&nbsp;<span class="text-text-dimmer">({aside})</span>{/if}
	</li>
{/snippet}

{#snippet column(heading: string, mark: "✓" | "✕", items: [string, string?][], testid: string)}
	<div data-testid={testid} class="min-w-0 flex-1">
		<h3 class={compact ? "sr-only" : "mb-[4px] text-[10px] font-semibold uppercase tracking-[0.06em] text-text-dimmer"}>{heading}</h3>
		<ul>
			{#each items as item, index (index)}{@render row(mark, item, index === 0 && mark === "✓" ? "handoff-message-count" : undefined)}{/each}
		</ul>
	</div>
{/snippet}

<Dialog {open} {onclose} placement={compact ? "sheet" : "center"} labelledBy={titleId}>
	<Surface
		variant="raised"
		radius="none"
		elevation="modal"
		data-testid="handoff-dialog"
		data-mode={confirm ? "confirm" : "review"}
		class="text-[11.5px] text-text-secondary {compact
			? 'w-full rounded-t-[18px] px-[14px] pt-[8px] pb-[calc(26px+env(safe-area-inset-bottom))]'
			: 'w-[560px] max-w-[calc(100vw-32px)] rounded-[14px] px-[18px] py-[16px]'}"
	>
		{#if compact}
			<div aria-hidden="true" class="mx-auto mb-[8px] h-[4px] w-[36px] rounded-full bg-border-chip"></div>
		{/if}
		<h2 id={titleId} class="font-semibold text-text {compact ? 'mt-[4px] mb-[6px] text-[13px]' : 'mb-[3px] text-[14px]'}">
			{confirm ? `Continue on ${nameOf(to)}?` : "What carried over?"}
		</h2>
		{#if confirm}
			{#if !compact}
				<p>The conversation is handed to a fresh session on this account, {confirm.cutOff ? "then Claude picks up the cut-off request." : "along with your next message."}</p>
			{/if}
			<Surface variant="quiet" radius="none" data-testid="handoff-swap" class="my-[10px] flex items-center gap-[10px] rounded-[10px] px-[10px] py-[8px] {compact ? 'flex-wrap' : ''}">
				<AccountDot instanceId={confirm.from} />
				<span>{nameOf(confirm.from)}</span>
				<QuotaMeter used={100} track={false} />
				<span aria-hidden="true" class="text-text-dimmer">→</span><span class="sr-only">to</span>
				<AccountDot instanceId={to} />
				<b class="font-semibold text-text">{nameOf(to)}</b>
				<span class="flex-1"></span>
				<QuotaMeter {...quotaReading(confirm.quota)} size="lg" track={!compact} />
			</Surface>
		{:else}
			<p>
				The conversation was handed to a fresh session on <b class="font-semibold text-text">{nameOf(to)}</b>{summary === null ? ". Nothing has gone across yet: the handoff counts once Claude finishes a reply there." : "."}
			</p>
		{/if}
		{#if summary !== null}
			<div class="mt-[12px] mb-[4px] flex {compact ? 'flex-col' : 'gap-[14px]'}">
				{@render column("Carries over", "✓", rows.carries, "handoff-carries")}
				{@render column("Doesn't carry over", "✕", rows.drops, "handoff-drops")}
			</div>
		{/if}
		<div class="mt-[12px] flex gap-[6px] {compact ? '' : 'justify-end'}">
			{#if confirm}
				<Button variant="ghost" size="content" data-testid="handoff-cancel" class={buttonClass} onclick={onclose}>Cancel</Button>
				<Button variant="inverse" size="content" iconSize={12} loading={confirm.busy} disabled={confirm.busy} data-testid="handoff-confirm" class="font-semibold {buttonClass}" onclick={confirm.onconfirm}>Switch and continue</Button>
			{:else}
				<Button variant="secondary" size="content" data-testid="handoff-close" class={buttonClass} onclick={onclose}>Close</Button>
			{/if}
		</div>
	</Surface>
</Dialog>

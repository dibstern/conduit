<!-- User transcript row. Preserves .msg-user class.
     Recognised `/skill` tokens render as the same pill the composer showed while
     typing; recognition is live (from the current command list), so the pill is
     derived at render rather than snapshotted at send. Typo near-misses that the
     composer underlined stay plain here — the message is already sent.
     The header carries the send time, rendered from the message's own
     `createdAt` — conduit's timestamps come from the event store, never from
     text a hook prepended to the message body. A queued send never renders
     here: it waits in the pending-input tray until the adapter places it. A
     steered message carries a "Steered" chip: it joined a running turn. -->

<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import {
		discoveryState,
		getModelDisplayName,
	} from "../../stores/discovery.svelte.js";
	import { extractDisplayText } from "../../utils/format.js";
	import { tokenizeSkills } from "../../../skill-recognition.js";
	import Badge from "../ui/Badge.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import MessageTime from "./MessageTime.svelte";

	let {
		message,
		onDismissCutOff,
	}: {
		message: UserMessage;
		/** Present while a usage limit has left this message unanswered; the
		 *  cut-off tag under the card calls it from its Dismiss link. */
		onDismissCutOff?: (() => void) | undefined;
	} = $props();

	const commandNames = $derived(
		new Set(discoveryState.commands.map((c) => c.name)),
	);
	const segments = $derived(
		tokenizeSkills(extractDisplayText(message.text), commandNames),
	);
</script>

<div class="msg-user mx-auto mb-[26px] grid max-w-[820px] grid-cols-[20px_minmax(0,1fr)] gap-x-[8px] px-[14px] md:grid-cols-[28px_minmax(0,1fr)] md:gap-x-[14px] md:px-[32px]" data-uuid={message.uuid}>
	<span aria-hidden="true" class="grid size-[20px] place-items-center self-start rounded-full bg-linear-to-br from-accent to-status-snoozed text-[11px] font-semibold text-white md:size-[28px] md:text-[13px]">Y</span>
	<div class="min-w-0 max-md:contents">
		<div data-testid="user-message-header" class="mb-[2px] flex min-h-[28px] flex-wrap items-center gap-x-[8px] gap-y-[4px]">
			<span class="text-[13.5px] font-semibold">You</span>
			<MessageTime createdAt={message.createdAt} />
			{#if message.steered}
				<Badge variant="chip" size="label" shape="pill" data-testid="user-message-steered" title="Joined the turn that was already running">Steered</Badge>
			{/if}
			{#if message.modelExecution?.drifted === true && message.modelExecution.requestedModel && message.modelExecution.expectedModel && message.modelExecution.actualModel}
				<Badge variant="chip" size="label" shape="pill" wrap data-testid="turn-model-drift">
					Ran {getModelDisplayName(message.modelExecution.actualModel)}, not {getModelDisplayName(message.modelExecution.requestedModel)}
				</Badge>
			{/if}
			{#if onDismissCutOff}
				<Badge variant="chip" size="label" shape="pill" data-testid="cut-off-tag">
					{sessionViewState.compact ? "Cut off" : "Cut off by usage limit"} · <TextButton tone="inherit" underline="always" touchTarget data-testid="cut-off-dismiss" onclick={onDismissCutOff}>Dismiss</TextButton>
				</Badge>
			{/if}
		</div>
		<div class="break-words whitespace-pre-wrap text-[15px] leading-[1.65] text-text max-md:col-span-2">
			{#each segments as seg (seg.key)}{#if seg.kind === "skill"}<span class="skill-pill">{seg.text}</span>{:else}{seg.text}{/if}{/each}
		</div>
	</div>
</div>

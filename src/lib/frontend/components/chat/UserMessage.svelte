<!-- ─── User Message ────────────────────────────────────────────────────────── -->
<!-- Left-aligned user message card with pink glow. Preserves .msg-user class.
     Recognised `/skill` tokens render as the same pill the composer showed while
     typing; recognition is live (from the current command list), so the pill is
     derived at render rather than snapshotted at send. Typo near-misses that the
     composer underlined stay plain here — the message is already sent.
     The header carries the send time, rendered from the message's own
     `createdAt` — conduit's timestamps come from the event store, never from
     text a hook prepended to the message body.
     When queued, the card is dimmed and shows a shimmering "Queued" label.
     The queued visual is DERIVED from the immutable `sentDuringEpoch` fact
     and the live `turnEpoch` — no mutable flags, no clearing needed. -->

<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import { currentChat } from "../../stores/chat.svelte.js";
	import {
		discoveryState,
		getModelDisplayName,
	} from "../../stores/discovery.svelte.js";
	import { extractDisplayText } from "../../utils/format.js";
	import { tokenizeSkills } from "../../utils/skill-highlight.js";
	import MessageTime from "./MessageTime.svelte";

	let { message }: { message: UserMessage } = $props();

	const commandNames = $derived(
		new Set(discoveryState.commands.map((c) => c.name)),
	);
	const segments = $derived(
		tokenizeSkills(extractDisplayText(message.text), commandNames),
	);

	/** True while the turn that was in-progress when this message was sent
	 *  hasn't completed yet. Clears automatically when `handleDone`
	 *  increments `turnEpoch`. */
	const isQueued = $derived(
		message.sentDuringEpoch != null &&
		currentChat().turnEpoch <= message.sentDuringEpoch,
	);
</script>

<div
	class="msg-user max-w-[760px] mx-auto mb-3 px-5"
	class:opacity-50={isQueued}
	data-uuid={message.uuid}
>
	<div
		class="bg-bg-surface rounded-panel py-4 px-5 relative glow-brand-a"
		class:border={isQueued}
		class:border-dashed={isQueued}
		class:border-border={isQueued}
	>
		<div class="flex items-baseline gap-2.5 mb-2">
			<span class="text-sm font-mono font-semibold uppercase tracking-[1.5px] text-brand-a">You</span>
			<MessageTime createdAt={message.createdAt} />
		</div>
		<div class="text-base leading-[1.7] break-words whitespace-pre-wrap text-text">
			{#each segments as seg (seg.key)}{#if seg.kind === "skill"}<span class="skill-pill">{seg.text}</span>{:else}{seg.text}{/if}{/each}
		</div>
		{#if message.modelExecution?.drifted === true && message.modelExecution.requestedModel && message.modelExecution.expectedModel && message.modelExecution.actualModel}
			<div
				data-testid="turn-model-drift"
				class="mt-3 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs leading-relaxed font-medium text-warning"
			>
				⚠ Ran {getModelDisplayName(message.modelExecution.actualModel)}, not {getModelDisplayName(message.modelExecution.requestedModel)}
			</div>
		{/if}
		{#if isQueued}
			<div class="flex items-center mt-2">
				<span class="queued-shimmer text-text-muted text-xs font-mono">Queued</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.queued-shimmer {
		background: linear-gradient(
			90deg,
			var(--color-text-muted) 0%,
			var(--color-text-secondary, #888) 50%,
			var(--color-text-muted) 100%
		);
		background-size: 200% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shimmer 2s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>

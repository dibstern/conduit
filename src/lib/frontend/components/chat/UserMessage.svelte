<!-- Left-aligned user message card with pink glow. Preserves .msg-user class.
     Recognised `/skill` tokens render as the same pill the composer showed while
     typing; recognition is live (from the current command list), so the pill is
     derived at render rather than snapshotted at send. Typo near-misses that the
     composer underlined stay plain here — the message is already sent.
     The header carries the send time, rendered from the message's own
     `createdAt` — conduit's timestamps come from the event store, never from
     text a hook prepended to the message body. A queued send never renders
     here: it waits in the pending-input tray until the adapter places it. -->

<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import {
		discoveryState,
		getModelDisplayName,
	} from "../../stores/discovery.svelte.js";
	import { extractDisplayText } from "../../utils/format.js";
	import { tokenizeSkills } from "../../../skill-recognition.js";
	import Surface from "../ui/Surface.svelte";
	import MessageTime from "./MessageTime.svelte";

	let { message }: { message: UserMessage } = $props();

	const commandNames = $derived(
		new Set(discoveryState.commands.map((c) => c.name)),
	);
	const segments = $derived(
		tokenizeSkills(extractDisplayText(message.text), commandNames),
	);
</script>

<div class="msg-user max-w-[760px] mx-auto mb-3 px-5" data-uuid={message.uuid}>
	<Surface variant="plain" padding="lg" class="relative glow-brand-a">
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
	</Surface>
</div>

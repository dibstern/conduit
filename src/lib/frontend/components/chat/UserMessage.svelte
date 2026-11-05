<!-- User transcript row. Preserves .msg-user class.
     Recognised `/skill` and `$builtin` tokens render as the same pill the composer showed while
     typing; recognition is live (from the current command list), so the pill is
     derived at render rather than snapshotted at send. Typo near-misses that the
     composer underlined stay plain here — the message is already sent.
     The header carries the send time, rendered from the message's own
     `createdAt` — conduit's timestamps come from the event store, never from
     text a hook prepended to the message body. A queued send never renders
     here: it waits in the pending-input tray until the adapter places it. A
     steered message carries a "Steered" chip: it joined a running turn.
     Edit resends new text as a sibling branch (82tn.51); the message where the
     conversation branched carries the branch switcher. -->

<script lang="ts">
	import { selection } from "../../stores/selection.svelte.js";
	import { SvelteSet } from "svelte/reactivity";
	import type { UserMessage } from "../../types.js";
	import { openMediaViewer } from "../../stores/ui.svelte.js";
	import {
		discoveryState,
		getModelDisplayName,
	} from "../../stores/discovery.svelte.js";
	import { extractDisplayText, formatFileSize } from "../../utils/format.js";
	import { tokenizeSkills } from "../../../skill-recognition.js";
	import Badge from "../ui/Badge.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import FileAttachmentChip from "../ui/FileAttachmentChip.svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import MessageTime from "./MessageTime.svelte";
	import UserAvatar from "../ui/UserAvatar.svelte";
	import Button from "../ui/Button.svelte";
	import AvatarPicker from "../overlays/AvatarPicker.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import BranchSwitcher from "./BranchSwitcher.svelte";
	import { type HeadFork, resendFrom } from "../../stores/head-moves.svelte.js";

	let {
		message,
		onDismissCutOff,
		sessionId,
		fork,
	}: {
		message: UserMessage;
		/** Present where the conversation's Head can move: edit and branch switch need it. */
		sessionId?: string | undefined;
		/** Present when the conversation branched at this message. */
		fork?: HeadFork | undefined;
		/** Present while a usage limit has left this message unanswered; the
		 *  cut-off tag under the card calls it from its Dismiss link. */
		onDismissCutOff?: (() => void) | undefined;
	} = $props();

	const commandNames = $derived(
		new Set(discoveryState.commands.map((c) => c.name)),
	);
	// The composer sends a `$builtin` as the `/builtin` providers expect; show it
	// as typed.
	const builtinNames = $derived(
		new Set(discoveryState.commands.filter((c) => c.builtin).map((c) => c.name)),
	);
	const segments = $derived(
		tokenizeSkills(extractDisplayText(message.text), commandNames),
	);
	const failedImages = new SvelteSet<string>();

	let draft = $state<string>();
	let sending = $state(false);

	async function resend(sessionId: string, messageId: string, text: string): Promise<void> {
		sending = true;
		// The resend carries text only; the note under the box says so when there were attachments.
		if (await resendFrom(sessionId, messageId, text)) draft = undefined;
		sending = false;
	}
</script>

<div class="msg-user group mx-auto mb-[26px] grid max-w-[820px] grid-cols-[20px_minmax(0,1fr)] gap-x-[8px] px-[14px] md:grid-cols-[28px_minmax(0,1fr)] md:gap-x-[14px] md:px-[32px]" data-uuid={message.uuid} data-message-id={message.messageId}>
	<AvatarPicker>
		{#snippet trigger({ props })}<Button {...props} variant="ghost" hoverFill="none" size="content" touchTarget ariaLabel="Change your avatar" class="self-start h-[28px] rounded-full"><UserAvatar size={sessionViewState.compact ? 20 : 28} /></Button>{/snippet}
	</AvatarPicker>
	<div class="min-w-0 max-md:contents">
		<!-- Mixed fonts and sizes: share a baseline, with the line centred on the avatar. -->
		<div data-testid="user-message-header" class="mb-[2px] flex min-h-[28px] flex-wrap content-center items-baseline gap-x-[8px] gap-y-[4px]">
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
			{#if fork && sessionId}<BranchSwitcher {fork} {sessionId} />{/if}
			{#if sessionId && message.messageId && message.text && draft === undefined}
				<Button variant="ghost" size="content" tone="dimmer" iconOnly icon="pencil" iconSize={14} touchTarget class="ml-auto size-[26px] self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100" title="Edit message" ariaLabel="Edit message" onclick={() => { draft = extractDisplayText(message.text); }} />
			{/if}
		</div>
		{#if draft !== undefined && sessionId && message.messageId}
			{@const messageId = message.messageId}
			<div data-testid="user-message-edit" class="flex flex-col gap-[8px] max-md:col-span-2">
				<Textarea bind:value={draft} aria-label="Edit message" rows={3} />
				{#if message.attachments?.length}<p class="text-[12px] text-text-dimmer">Attachments are not resent.</p>{/if}
				<div class="flex justify-end gap-[8px]">
					<Button variant="ghost" size="sm" onclick={() => { draft = undefined; }}>Cancel</Button>
					<Button variant="primary" size="sm" disabled={sending || !draft.trim()} onclick={() => draft && resend(sessionId, messageId, draft.trim())}>Send</Button>
				</div>
			</div>
		{:else if message.text}
			<div class="break-words whitespace-pre-wrap text-[15px] leading-[1.65] text-text max-md:col-span-2">
				{#each segments as seg (seg.key)}{#if seg.kind === "skill"}<span class="skill-pill">{builtinNames.has(seg.text.slice(1)) ? `$${seg.text.slice(1)}` : seg.text}</span>{:else}{seg.text}{/if}{/each}
			</div>
		{/if}
		{#if message.attachments?.length}
			<div data-testid="user-message-attachments" class="mt-[8px] flex min-w-0 flex-wrap items-start gap-[8px] max-md:col-span-2">
				{#each message.attachments as attachment (attachment.id)}
					{@const url = attachment.source.attachmentHash !== undefined ? `/p/${encodeURIComponent(selection.scope?.project ?? "")}/attachments/${attachment.source.attachmentHash}` : attachment.source.url}
					{#if attachment.mime.startsWith("image/")}
						{#if failedImages.has(url)}
							<span role="img" aria-label={attachment.name} class="flex size-[96px] items-center justify-center rounded-[10px] bg-bg-raised p-2 text-center text-xs text-text-muted">image unavailable</span>
						{:else}
							<Button variant="ghost" hoverFill="none" size="content" ariaLabel={`View image ${attachment.name}`} class="rounded-[10px] cursor-zoom-in" onclick={(event) => openMediaViewer({ kind: "image", src: url }, event.currentTarget)}>
								<img src={url} alt={attachment.name} class="size-[96px] rounded-[10px] bg-bg-raised object-contain" onerror={() => failedImages.add(url)} />
							</Button>
						{/if}
					{:else}
						<FileAttachmentChip testid="user-message-file" name={attachment.name} detail={attachment.size === undefined ? attachment.mime : `${attachment.mime} · ${formatFileSize(attachment.size)}`} />
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>

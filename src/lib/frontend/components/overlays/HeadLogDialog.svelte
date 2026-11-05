<!-- The Head Log (82tn.51): every move of the session's conversation, newest first. Each can be
     undone, and an undo is itself a new entry. "Rewind to a message" is the way into the rewind
     dialog. Reached from a reply's message menu, so it works on a phone; a bottom sheet there. -->
<script lang="ts">
	import { headLog, type HeadLogEntry, undoMove } from "../../stores/head-moves.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { enterRewindMode } from "../../stores/ui.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import MessageTime from "../chat/MessageTime.svelte";
	import Button from "../ui/Button.svelte";
	import Modal from "../ui/Modal.svelte";

	let entries = $state<readonly HeadLogEntry[]>();

	async function load(sessionId: string): Promise<void> {
		try {
			const result = await rpc("GetHeadLog", { sessionId });
			if (headLog.sessionId === sessionId) entries = result.entries;
		} catch (error) {
			toastFailure("Could not load the head log.")(error);
		}
	}

	$effect(() => {
		entries = undefined;
		if (headLog.sessionId) void load(headLog.sessionId);
	});

	const label = (entry: HeadLogEntry): string =>
		entry.kind === "undo" ? "Undid a move"
		: entry.kind === "switch" ? "Switched branch"
		: entry.resend ? `Resent "${entry.resend}"`
		: "Rewound";

	async function undo(sessionId: string, moveId: string): Promise<void> {
		if (await undoMove(sessionId, moveId)) await load(sessionId);
	}

	function close(): void {
		headLog.sessionId = undefined;
	}

	function rewindToMessage(): void {
		close();
		enterRewindMode();
	}
</script>

<Modal open={headLog.sessionId !== undefined} onclose={close} title="Head Log" placement={sessionViewState.compact ? "sheet" : "center"}>
	<div data-testid="head-log" class="flex flex-col gap-3">
		{#if entries?.length === 0}
			<p class="text-sm text-text-secondary">No moves yet.</p>
		{:else if entries}
			<ul class="flex flex-col">
				{#each entries as entry (entry.moveId)}
					<li data-testid="head-log-entry" class="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-sm text-text">{label(entry)}</span>
							<span class="text-xs text-text-dimmer"><MessageTime createdAt={entry.at} />{entry.landed ? "" : " · landing"}</span>
						</div>
						<Button variant="ghost" size="sm" touchTarget disabled={!entry.landed} onclick={() => headLog.sessionId && undo(headLog.sessionId, entry.moveId)}>Undo</Button>
					</li>
				{/each}
			</ul>
		{/if}
		<Button variant="secondary" size="sm" class="self-start" onclick={rewindToMessage}>Rewind to a message</Button>
	</div>
</Modal>

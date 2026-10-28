<!--
  Lists the open session's Side Threads, newest first. Opened from the header's
  Side Threads control or by a bare `$btw`: a drop-down sheet on phones and a popover
  anchored under the control on desktop.
-->
<script lang="ts" module>
	import { sessionAttention, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import type { Immutable, SessionInfo } from "../../types.js";
	import { ATTENTION_DISPLAY } from "./SessionItem.svelte";

	/** The sidebar's blocking glyph for the most urgent Side Thread waiting on you. */
	export function waitingMarker(
		threads: readonly Immutable<SessionInfo>[],
	): { attention: "needs-approval" | "needs-reply"; colour: string; spoken: string } | undefined {
		const attentions = new Set(threads.map(sessionAttention));
		const attention = (["needs-approval", "needs-reply"] as const).find((tier) => attentions.has(tier));
		if (!attention) return undefined;
		const { colour, spoken } = ATTENTION_DISPLAY[attention];
		return { attention, colour, spoken };
	}
</script>

<script lang="ts">
	import { formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import SessionStatusGlyph from "../ui/SessionStatusGlyph.svelte";
	import Popover from "../ui/Popover.svelte";
	import Surface from "../ui/Surface.svelte";
	import { sessionCommandActions } from "./session-commands.js";
	import { sideThreadsPanel } from "./side-threads.svelte.js";

	let { threads, compact }: { threads: readonly Immutable<SessionInfo>[]; compact: boolean } = $props();

	function open(thread: Immutable<SessionInfo>) {
		sideThreadsPanel.open = false;
		selection.open(thread.id);
	}

	function remove(thread: Immutable<SessionInfo>, button: HTMLElement) {
		void sessionCommandActions.remove(thread, () => button.isConnected ? button : document.getElementById("side-threads-control"));
	}
</script>

{#snippet panel()}
<Surface id="side-threads-panel" data-testid="side-threads-panel" variant={compact ? "plain" : "floating"} radius="none" elevation={compact ? "none" : "popover"} role="region" aria-label="Side Threads" class="whitespace-normal border-border px-[14px] pt-[12px] pb-[10px] text-[12px] {compact ? '' : 'absolute top-full z-[var(--z-popover)] max-h-[70dvh] overflow-y-auto right-[16px] mt-[8px] w-[440px] max-w-[calc(100%-32px)] rounded-[16px]'}">
	<!-- Desktop heads its card in sentence case, like the goal card's "Checks". -->
	<div class="flex items-center gap-[7px] font-sans text-text-secondary {compact ? 'text-[11px] font-semibold uppercase tracking-[0.08em]' : 'text-[12px] font-medium'}">
		<Icon name="messages-square" size={13} />{compact ? "Side Threads" : "Side threads"}
	</div>
	{#if threads.length > 0}
		<ul data-testid="side-threads-list" class="m-0 mt-2 list-none p-0">
			{#each threads as thread (thread.id)}
				{@const marker = waitingMarker([thread])}
				{@const title = thread.title || "New Session"}
				{@const unread = sessionAttention(thread) === "done-unread"}
				<li data-testid="side-thread" class="flex items-center gap-1 border-t border-border-subtle py-[3px]">
					<Button variant="ghost" size="content" layout="flow" tone="default" hoverFill="text" data-testid="side-thread-open" class="-ml-[6px] grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[8px] py-[5px] pr-[4px] pl-[6px] text-left" onclick={() => open(thread)}>
						{#if marker}
							<span data-testid="side-thread-waiting" class="inline-flex {marker.colour}"><SessionStatusGlyph attention={marker.attention} size={14} /></span>
						{:else}
							<Icon name="messages-square" size={14} class="text-text-dimmer" />
						{/if}
						<span class="flex min-w-0 items-center gap-1.5">
							<span data-testid="side-thread-title" class="truncate">{title}</span>
							{#if unread}
								<span data-testid="side-thread-unread-dot" class="size-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
							{/if}
							<span class="sr-only">{marker ? `, ${marker.spoken}` : ""}{unread ? ", unread" : ""}</span>
						</span>
						<span data-testid="side-thread-time" class="text-[11px] text-text-muted tabular-nums">{formatTimeAgo(thread.updatedAt ?? thread.createdAt, new Date(sessionState.now))}</span>
					</Button>
					<Button variant="ghost" size="content" iconOnly icon="trash-2" iconSize={13} tone="dimmer" hoverFill="text" touchTarget class="size-[26px] shrink-0 justify-center rounded-[7px]" ariaLabel={`Delete ${title}`} title="Delete" data-testid="side-thread-delete" onclick={(event) => remove(thread, event.currentTarget as HTMLElement)} />
				</li>
			{/each}
		</ul>
	{:else}
		<p data-testid="side-threads-empty" class="m-0 mt-2 text-[11px] leading-[1.45] text-text-muted">No Side Threads yet. Type <span class="font-mono text-text-secondary">$btw</span> and a question to ask one.</p>
	{/if}
</Surface>
{/snippet}

{#if compact}
	<Popover bind:open={sideThreadsPanel.open} presentation="sheet" sheetEdge="top" ariaLabel="Side Threads" portalTo="#session-bar" sheetBottomPadding={0} sheetScrim={{ testId: "side-threads-scrim" }}>
		{#snippet trigger()}{/snippet}
		{@render panel()}
	</Popover>
{:else}
	{@render panel()}
{/if}

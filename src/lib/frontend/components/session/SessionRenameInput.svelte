<script module lang="ts">
	// Open drafts by session id. They outlive the field because a row is
	// rebuilt whenever its session moves between status groups, and the rebuilt
	// field must pick up what was typed.
	const drafts = new Map<string, { value: string; seededTitle: string; owner: symbol }>();
</script>

<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { sessionVerbActions } from "./session-verbs.js";

	let { session, onend, variant = "header", class: className = "" }: {
		session: SessionInfo;
		onend: () => void;
		/** `row` matches the sidebar title it replaces and shows key hints. */
		variant?: "row" | "header";
		class?: string | undefined;
	} = $props();

	// Read once. `session` is replaced on every status update, so tracking it
	// here would overwrite the draft mid-typing.
	const sessionId = untrack(() => session.id);
	const owner = Symbol();
	const draft = untrack(() => {
		const title = session.title || "New Session";
		const claimed = drafts.get(sessionId) ?? { value: title, seededTitle: title, owner };
		claimed.owner = owner;
		drafts.set(sessionId, claimed);
		return claimed;
	});
	// A rebuilt field claims the draft in the same update; only an unclaimed
	// one is abandoned.
	onDestroy(() => queueMicrotask(() => { if (draft.owner === owner) drafts.delete(sessionId); }));

	const seededTitle = draft.seededTitle;
	let value = $state(draft.value);
	let element = $state<HTMLInputElement>();
	// Caret at the end, so a rebuilt field carries on where typing left off.
	$effect(() => { element?.setSelectionRange(draft.value.length, draft.value.length); });
	let dismissedTitle = $state<string | undefined>();
	// A title that lands mid-edit (usually the agent's auto-title) is offered,
	// never applied over the draft.
	const incomingTitle = $derived(
		session.title && session.title !== seededTitle && session.title !== value.trim() && session.title !== dismissedTitle
			? session.title
			: undefined,
	);
	let ended = false;

	function commit() {
		if (ended) return;
		ended = true;
		drafts.delete(sessionId);
		const title = value.trim();
		onend();
		// An untouched draft is not a rename: saving it would revert a title
		// that arrived while the field was open.
		if (title && title !== seededTitle && title !== session.title) void sessionVerbActions.rename(session, title);
	}

	// A rebuilt row's field autofocuses while the old one is still attached, and
	// a removed one blurs on the way out. Neither is the user leaving the field.
	function commitOnBlur(event: FocusEvent & { currentTarget: HTMLInputElement }) {
		if (event.currentTarget.isConnected && draft.owner === owner) commit();
	}

	function cancel() {
		if (ended) return;
		ended = true;
		drafts.delete(sessionId);
		onend();
	}

	// The row is a link and the input commits on blur: suggestion buttons must
	// neither navigate nor steal focus.
	function keepFocus(event: MouseEvent) { event.preventDefault(); }
	function contain(event: MouseEvent) { event.preventDefault(); event.stopPropagation(); }
</script>

<!-- The row variant's padding leaves room for its glow ring: the title cell
     around it clips overflow. -->
<span class="flex min-w-0 flex-1 flex-col gap-1 {variant === 'row' ? 'p-[3px]' : ''}">
	<TextInput
		aria-label="Session name"
		size={variant === "row" ? "content" : "sm"}
		chrome={variant === "row" ? "bare" : "bordered"}
		class={variant === "row"
			? `block w-full rounded-sm border border-brand-a bg-bg px-1.5 py-0.5 font-medium text-text ring-3 ring-brand-a-glow ${className}`
			: className}
		bind:value
		bind:element
		oninput={() => { draft.value = value; }}
		onkeydown={(event) => {
			if (event.key === "Enter") { event.preventDefault(); commit(); }
			else if (event.key === "Escape") { event.preventDefault(); cancel(); }
		}}
		onblur={commitOnBlur}
		onclick={contain}
		autofocus
	/>
	{#if variant === "row"}
		<!-- Buttons, not just hints: phone keyboards have no Esc, and a tap
		     elsewhere saves. -->
		<span class="flex gap-2.5 text-xs text-text-dimmer">
			<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget
				class="gap-1 hover:text-text-secondary"
				onmousedown={keepFocus}
				ariaLabel="Save"
				onclick={(event) => { contain(event); commit(); }}
			><kbd class="rounded-sm border border-border px-1 font-[inherit] text-text-secondary">↵</kbd> save</Button>
			<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget
				class="gap-1 hover:text-text-secondary"
				onmousedown={keepFocus}
				ariaLabel="Cancel"
				onclick={(event) => { contain(event); cancel(); }}
			><kbd class="rounded-sm border border-border px-1 font-[inherit] text-text-secondary">esc</kbd> cancel</Button>
		</span>
	{/if}
	{#if incomingTitle}
		<span class="flex min-w-0 items-center gap-1.5 text-sm text-text-dimmer" role="status" data-testid="session-rename-incoming">
			<span class="min-w-0 truncate" title={incomingTitle}>Now titled <span class="text-text-secondary">“{incomingTitle}”</span></span>
			<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget
				class="shrink-0 text-brand-b hover:underline"
				onmousedown={keepFocus}
				onclick={(event) => { contain(event); value = draft.value = incomingTitle; }}
			>Use</Button>
			<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget
				class="shrink-0 hover:text-text-secondary"
				onmousedown={keepFocus}
				onclick={(event) => { contain(event); dismissedTitle = incomingTitle; }}
			>Dismiss</Button>
		</span>
	{/if}
</span>

<script lang="ts">
	import { tick } from "svelte";

	/**
	 * Test article for conduit-test-n9s (3G.1) — the two competing ARIA shapes for
	 * conduit's message composer, rendered faithfully so a screen reader can be
	 * pointed at each and the difference RECORDED rather than argued about.
	 *
	 * Variant A (option 3A, status quo on ds/de3-3-9-combobox): textarea carries
	 *   role=combobox + aria-expanded. Non-conforming per W3C ARIA in HTML, which
	 *   gives <textarea> permitted roles = "No role". Ships on google.com.
	 * Variant B (option 3C): no role, no aria-expanded. Keeps aria-controls,
	 *   aria-activedescendant, aria-autocomplete, aria-haspopup, and restores the
	 *   "menu opened" signal with a visually-hidden role=status.
	 *
	 * The two arms are written out as separate literal <textarea> blocks rather than
	 * one block full of ternaries. The attribute set IS the experiment, so it has to
	 * be auditable at a glance; a reviewer should not have to evaluate conditionals
	 * to know what is under test.
	 *
	 * Everything OTHER than the textarea is deliberately identical across arms,
	 * including two oddities copied verbatim from the shipping FileMenu.svelte:
	 * the listbox carries tabindex="0", and it repeats aria-activedescendant even
	 * though it never takes DOM focus. Both look wrong. They are reproduced on
	 * purpose: they are what conduit actually ships, they are constant across arms
	 * so they cannot confound A vs B, and silently "fixing" them here would mean
	 * measuring a composer that does not exist. Tracked separately.
	 */

	type Variant = "A" | "B";

	const { variant }: { variant: Variant } = $props();

	/** Static fixture — the harness must run with no backend. */
	const FILES = [
		"src/lib/frontend/components/input/InputArea.svelte",
		"src/lib/frontend/components/input/FileMenu.svelte",
		"src/lib/frontend/components/input/CommandMenu.svelte",
		"src/lib/relay/relay-stack.ts",
		"docs/agent-guide/architecture.md",
	];

	const listboxId = $derived(`variant-${variant}-file-listbox`);
	const inputId = $derived(`variant-${variant}-input`);

	let value = $state("");
	let activeIndex = $state(0);
	let textareaEl = $state<HTMLTextAreaElement | undefined>();

	/** The `@`-token between the nearest `@` and the caret, or undefined. */
	let token = $state<string | undefined>(undefined);

	const matches = $derived.by(() => {
		const t = token;
		if (t === undefined) return [];
		return FILES.filter((f) => f.toLowerCase().includes(t.toLowerCase()));
	});

	const open = $derived(matches.length > 0);
	const activeOptionId = $derived(
		open ? `${listboxId}-option-${activeIndex}` : undefined,
	);
	const statusText = $derived(
		open ? `${matches.length} file${matches.length === 1 ? "" : "s"} available` : "",
	);

	function syncToken(el: HTMLTextAreaElement) {
		const caret = el.selectionStart ?? 0;
		const before = el.value.slice(0, caret);
		const at = before.lastIndexOf("@");
		// A live token runs from '@' to the caret with no whitespace inside it.
		const next =
			at === -1 || /\s/.test(before.slice(at + 1))
				? undefined
				: before.slice(at + 1);
		// Bail when the token is unchanged, so that selection-tracking calls cannot
		// clobber the highlight. syncToken also runs on keyup and click to follow the
		// caret, and ArrowDown produces a keyup: resetting activeIndex unconditionally
		// meant every arrow press moved the highlight and then immediately snapped it
		// back to 0. Silent in the UI (the menu still looked alive) but it would have
		// made every 3G.2 transcript show option 1 announced over and over.
		if (next === token) return;
		token = next;
		activeIndex = 0;
	}

	async function commit(file: string) {
		const el = textareaEl;
		if (!el || token === undefined) return;
		const caret = el.selectionStart ?? 0;
		const at = value.slice(0, caret).lastIndexOf("@");
		if (at === -1) return;
		value = `${value.slice(0, at)}${file} ${value.slice(caret)}`;
		token = undefined;
		const next = at + file.length + 1;
		await tick();
		el.setSelectionRange(next, next);
		el.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % matches.length;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = (activeIndex - 1 + matches.length) % matches.length;
		} else if (e.key === "Enter") {
			e.preventDefault();
			const file = matches[activeIndex];
			if (file !== undefined) void commit(file);
		} else if (e.key === "Escape") {
			e.preventDefault();
			token = undefined;
		}
	}

	function handleInput(e: Event & { currentTarget: HTMLTextAreaElement }) {
		value = e.currentTarget.value;
		syncToken(e.currentTarget);
	}
</script>

<div class="w-full max-w-[560px]" data-testid="composer-variant-{variant}">
	<h2 class="mb-2 text-base font-semibold text-text">
		Variant {variant}
		<span class="font-normal text-text-muted">
			{variant === "A" ? "role=combobox (3A)" : "plain textbox + status (3C)"}
		</span>
	</h2>

	{#if open}
		<div
			id={listboxId}
			role="listbox"
			aria-label="File suggestions"
			tabindex="0"
			aria-activedescendant={activeOptionId}
			data-testid="listbox-{variant}"
			class="mb-1 rounded border border-border bg-bg-alt py-1"
		>
			{#each matches as file, i (file)}
				<div
					id="{listboxId}-option-{i}"
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					class="cursor-pointer px-3.5 py-2 text-base {i === activeIndex
						? 'bg-accent-bg'
						: 'hover:bg-bg'}"
					onmousedown={(e) => {
						e.preventDefault();
						void commit(file);
					}}
					onmouseenter={() => {
						activeIndex = i;
					}}
				>
					{file}
				</div>
			{/each}
		</div>
	{/if}

	{#if variant === "A"}
		<textarea
			id={inputId}
			aria-label="Message"
			role="combobox"
			aria-autocomplete="list"
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-controls={open ? listboxId : undefined}
			aria-activedescendant={activeOptionId}
			rows="2"
			placeholder="Ask anything. @ to mention files"
			autocomplete="off"
			data-testid="input-{variant}"
			class="w-full resize-none rounded border border-border bg-bg px-2.5 py-2 text-base text-text outline-none placeholder:text-text-muted"
			{value}
			bind:this={textareaEl}
			oninput={handleInput}
			onkeydown={handleKeydown}
			onclick={(e) => syncToken(e.currentTarget)}
			onkeyup={(e) => syncToken(e.currentTarget)}
		></textarea>
	{:else}
		<textarea
			id={inputId}
			aria-label="Message"
			aria-autocomplete="list"
			aria-haspopup="listbox"
			aria-controls={open ? listboxId : undefined}
			aria-activedescendant={activeOptionId}
			rows="2"
			placeholder="Ask anything. @ to mention files"
			autocomplete="off"
			data-testid="input-{variant}"
			class="w-full resize-none rounded border border-border bg-bg px-2.5 py-2 text-base text-text outline-none placeholder:text-text-muted"
			{value}
			bind:this={textareaEl}
			oninput={handleInput}
			onkeydown={handleKeydown}
			onclick={(e) => syncToken(e.currentTarget)}
			onkeyup={(e) => syncToken(e.currentTarget)}
		></textarea>
		<!--
			Variant B's replacement for aria-expanded. role=status is an implicit
			aria-live=polite region: the opened signal is SPOKEN rather than exposed
			as widget state. Whether that is equivalent, better, or worse is exactly
			what 3G.2 measures.
		-->
		<div class="sr-only" role="status" data-testid="status-{variant}">
			{statusText}
		</div>
	{/if}
</div>

<!-- ─── SessionSearchField ──────────────────────────────────────────────────── -->
<!-- One row for both "which sessions" questions: a scope chip that narrows the -->
<!-- list to a project, and the title search. Typing project:<slug> sets the    -->
<!-- same chip. Both write ?p=<slug> in the URL (stores/session-scope.ts).      -->

<script lang="ts">
	import { projectState } from "../../stores/project.svelte.js";
	import {
		getSessionScope,
		setSessionScope,
		takeScopeToken,
	} from "../../stores/session-scope.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let {
		value,
		oninput,
		onescape,
		onaddproject,
	}: {
		value: string;
		oninput: (text: string) => void;
		onescape: () => void;
		onaddproject?: (() => void) | undefined;
	} = $props();

	// Radio value for "no scope". A project slug is never empty.
	const ALL_PROJECTS = "";

	let input: HTMLInputElement | undefined = $state();
	let pickerOpen = $state(false);

	const scope = $derived(getSessionScope());
	const scopeLabel = $derived(
		scope === null ? "All projects" : projectTitle(scope),
	);

	function projectTitle(slug: string): string {
		return (
			projectState.projects.find((project) => project.slug === slug)?.title ||
			slug
		);
	}

	// A finished project: token becomes the chip and leaves the text, so the
	// two can never both be on screen saying different things.
	function applyText(text: string, submitted: boolean) {
		const token = takeScopeToken(
			text,
			projectState.projects.map((project) => project.slug),
			submitted,
		);
		if (token === null) {
			oninput(text);
			return;
		}
		setSessionScope(token.slug);
		if (input) input.value = token.text;
		oninput(token.text);
	}

	function handleKeydown(event: KeyboardEvent) {
		const field = event.currentTarget as HTMLInputElement;
		if (event.key === "Enter") {
			event.preventDefault();
			applyText(field.value, true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			onescape();
		} else if (
			event.key === "Backspace" &&
			scope !== null &&
			field.selectionStart === 0 &&
			field.selectionEnd === 0
		) {
			// Backspace before the first character deletes the token in front
			// of it, as in any token field: the same as the chip's clear.
			event.preventDefault();
			setSessionScope(null);
		}
	}

	function isEditable(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			(target.isContentEditable ||
				["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
		);
	}

	// `/` to search and Cmd/Ctrl+P to the scope, on pointer devices only: a
	// touch device has no keyboard to press them with, and a stray key from a
	// paired one should not pull focus into a hidden route panel.
	function handleShortcut(event: KeyboardEvent) {
		if (event.defaultPrevented || event.altKey || event.shiftKey) return;
		if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
			return;
		}
		const modifier = event.metaKey || event.ctrlKey;
		if (modifier && event.key.toLowerCase() === "p") {
			event.preventDefault();
			pickerOpen = true;
		} else if (!modifier && event.key === "/" && !isEditable(event.target)) {
			event.preventDefault();
			input?.focus();
		}
	}
</script>

<svelte:window onkeydown={handleShortcut} />

<div
	class="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-bg-surface pl-1 pr-2 focus-within:border-border-chip focus-within:bg-bg-alt"
	data-testid="session-search-field"
>
	<Menu bind:open={pickerOpen} ariaLabel="Project scope">
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant="pill"
				size="content"
				class="max-w-[60%] shrink-0"
				title="Project scope (⌘P)"
				data-testid="session-scope-chip"
			>
				<span class="truncate">{scopeLabel}</span>
				<Icon name="chevron-down" size={12} />
			</Button>
		{/snippet}

		<MenuRadioGroup
			value={scope ?? ALL_PROJECTS}
			onvaluechange={(next) => setSessionScope(next === ALL_PROJECTS ? null : next)}
		>
			<MenuRadioItem value={ALL_PROJECTS}>All projects</MenuRadioItem>
			{#each projectState.projects as project (project.slug)}
				<MenuRadioItem value={project.slug}>
					<!-- The token beside each name teaches the typed form by use. -->
					<span class="flex min-w-0 items-center justify-between gap-3">
						<span class="truncate">{project.title || project.slug}</span>
						<span class="shrink-0 font-mono text-xs text-text-dimmer">project:{project.slug}</span>
					</span>
				</MenuRadioItem>
			{/each}
		</MenuRadioGroup>
		{#if onaddproject}
			<MenuSeparator />
			<MenuItem onselect={onaddproject}>Add a project…</MenuItem>
		{/if}
	</Menu>
	{#if scope !== null}
		<Button
			variant="toolbar"
			size="content"
			class="h-5 w-5 shrink-0 rounded-full"
			iconOnly
			icon="x"
			iconSize={12}
			title="Show all projects"
			ariaLabel="Clear project scope"
			onclick={() => setSessionScope(null)}
		/>
	{/if}
	<Icon name="search" size={12} class="shrink-0 text-text-dimmer" />
	<TextInput
		bind:element={input}
		id="session-search-input"
		aria-label="Search sessions"
		chrome="bare"
		size="content"
		class="min-w-0 flex-1 bg-transparent text-xs text-text font-brand placeholder:text-text-dimmer"
		placeholder="Search sessions..."
		autocomplete="off"
		spellcheck={false}
		{value}
		oninput={(event) => applyText(event.currentTarget.value, false)}
		onkeydown={handleKeydown}
	/>
</div>

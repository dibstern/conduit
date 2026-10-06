<!-- One row for both "which sessions" questions: a scope chip that narrows the -->
<!-- list to a project, and the title search. Typing project:<slug> sets the    -->
<!-- same chip. Both write ?p=<slug> in the URL (stores/session-scope.ts).      -->

<script lang="ts">
	import { applyProjectMutationResponse, confirmRemoveProjects, projectState } from "../../stores/project.svelte.js";
	import {
		getSessionScope,
		setSessionScope,
		takeScopeToken,
	} from "../../stores/session-scope.js";
	import type { ProjectInfo } from "../../types.js";
	import ProjectDialog from "../project/ProjectDialog.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuCheckboxItem from "../ui/MenuCheckboxItem.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import ProjectScopeItem from "./ProjectScopeItem.svelte";
	import Surface from "../ui/Surface.svelte";
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
	let scopeChip: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	let pickerOpen = $state(false);
	// Select mode swaps the scope radios for checkboxes, for removing several
	// projects at once. It lasts only while the menu stays open.
	let selecting = $state(false);
	let selected: readonly string[] = $state([]);
	let editing: ProjectInfo | null = $state(null);
	// Focusing or typing in the input raises the suggestions; they stay up while
	// focus is anywhere in the field, and Escape hides them without leaving it.
	let focused = $state(false);

	// What the field is suggesting for: "" on an empty field, the typed part of
	// a trailing `project:` token, or null once the text is a plain search.
	const scopeQuery = $derived.by(() => {
		if (value.trim() === "") return "";
		return /(?:^|\s)project:(\S*)$/i.exec(value)?.[1]?.toLowerCase() ?? null;
	});
	const scopeOptions = $derived(
		scopeQuery === null
			? []
			: projectState.projects.filter(
					(project) =>
						project.slug.toLowerCase().includes(scopeQuery) ||
						project.title.toLowerCase().includes(scopeQuery),
				),
	);
	const suggesting = $derived(focused && !pickerOpen && scopeQuery !== null);

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

	// Picking a suggestion is the same as finishing the typed token: the chip
	// takes the scope and any half-typed `project:` leaves the text.
	function pickScope(slug: string | null) {
		setSessionScope(slug);
		const text = value.replace(/(^|\s)project:\S*$/i, "$1");
		if (text === value) return;
		if (input) input.value = text;
		oninput(text);
	}

	function setPickerOpen(open: boolean) {
		pickerOpen = open;
		if (open) return;
		selecting = false;
		selected = [];
	}

	// The menu closes first so the confirm opens over the list, not the menu.
	async function removeProjects(slugs: readonly string[]) {
		setPickerOpen(false);
		const removed = await confirmRemoveProjects(slugs, () => scopeChip ?? null);
		const current = getSessionScope();
		if (removed && current !== null && slugs.includes(current)) setSessionScope(null);
	}

	function handleFocusOut(event: FocusEvent) {
		const next = event.relatedTarget;
		if (!(next instanceof Node && (event.currentTarget as HTMLElement).contains(next))) {
			focused = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		const field = event.currentTarget as HTMLInputElement;
		if (event.key === "Enter") {
			event.preventDefault();
			applyText(field.value, true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (suggesting) focused = false;
			else onescape();
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
	class="relative flex h-[38px] md:h-[32px] items-center gap-[8px] rounded-[11px] border border-border-subtle bg-bg-surface pl-[6px] md:pl-[7px] pr-[11px] text-[13.5px] md:text-[12.5px] focus-within:border-border-chip focus-within:bg-bg-alt"
	data-testid="session-search-field"
	onfocusout={handleFocusOut}
>
	<!-- One pill: "All projects ▾" at rest, a removable "conduit ✕" token once
	     scoped, the same thing `project:conduit` compiles to. -->
	<span class="flex max-w-[60%] shrink-0 items-center rounded-full border border-border-chip bg-bg-alt">
	<Menu bind:open={() => pickerOpen, setPickerOpen} ariaLabel="Project scope">
		{#snippet trigger({ props })}
			<Button
				{...props}
				bind:element={scopeChip}
				variant="ghost"
				size="content"
				tone="default"
				touchTarget
				class="min-w-0 gap-1 rounded-full px-[8px] py-[5px] md:px-[7px] md:py-[4px] text-[11.5px] md:text-[11px] leading-none font-medium font-brand"
				title="Project scope (⌘P)"
				data-testid="session-scope-chip"
			>
				<span class="truncate">{scopeLabel}</span>
				{#if scope === null}<Icon name="chevron-down" size={12} />{/if}
			</Button>
		{/snippet}

		{#if selecting}
			{#each projectState.projects as project (project.slug)}
				<MenuCheckboxItem
					class="min-h-[44px] md:min-h-0"
					closeOnSelect={false}
					data-testid="session-scope-select-item"
					bind:checked={
						() => selected.includes(project.slug),
						(on) => {
							selected = on
								? [...selected, project.slug]
								: selected.filter((slug) => slug !== project.slug);
						}
					}
				>
					{project.title || project.slug}
				</MenuCheckboxItem>
			{/each}
			<MenuSeparator />
			<MenuItem
				variant="danger"
				class="min-h-[44px] md:min-h-0"
				disabled={selected.length === 0}
				data-testid="session-scope-remove-selected"
				onselect={() => void removeProjects(selected)}
			>
				{selected.length === 0
					? "Remove projects"
					: `Remove ${selected.length} project${selected.length === 1 ? "" : "s"}`}
			</MenuItem>
			<MenuItem
				class="min-h-[44px] md:min-h-0"
				closeOnSelect={false}
				onselect={() => { selecting = false; selected = []; }}
			>
				Cancel
			</MenuItem>
		{:else}
			<MenuRadioGroup
				value={scope ?? ALL_PROJECTS}
				onvaluechange={(next) => setSessionScope(next === ALL_PROJECTS ? null : next)}
			>
				<MenuRadioItem value={ALL_PROJECTS} class="min-h-[44px] md:min-h-0">All projects</MenuRadioItem>
				{#each projectState.projects as project (project.slug)}
					<ProjectScopeItem
						{project}
						onremove={(slug) => void removeProjects([slug])}
						onedit={(target) => { setPickerOpen(false); editing = target; }}
					/>
				{/each}
			</MenuRadioGroup>
			{#if projectState.projects.length > 0 || onaddproject}<MenuSeparator />{/if}
			{#if projectState.projects.length > 0}
				<MenuItem
					class="min-h-[44px] md:min-h-0"
					closeOnSelect={false}
					data-testid="session-scope-select"
					onselect={() => { selecting = true; }}
				>
					Select projects…
				</MenuItem>
			{/if}
			{#if onaddproject}
				<MenuItem class="min-h-[44px] md:min-h-0" onselect={onaddproject}>Add a project…</MenuItem>
			{/if}
		{/if}
	</Menu>
	{#if scope !== null}
		<Button
			variant="toolbar"
			size="content"
			touchTarget
			class="-ml-[3px] mr-[3px] h-[16px] w-[16px] shrink-0 rounded-full"
			iconOnly
			icon="x"
			iconSize={11}
			title="Show all projects"
			ariaLabel="Clear project scope"
			onclick={() => setSessionScope(null)}
		/>
	{/if}
	</span>
	<Icon name="search" size={13} class="shrink-0 text-text-dimmer" />
	<!-- The field paints 38px tall; the negative margin lets the transparent
	     input overhang its border to keep a 44px tap target on phones. -->
	<TextInput
		bind:element={input}
		id="session-search-input"
		aria-label="Search sessions"
		chrome="bare"
		size="content"
		class="min-w-0 flex-1 self-stretch -my-[4px] md:my-0 bg-transparent text-[13.5px] md:text-[12.5px] text-text font-brand placeholder:text-text-dimmer"
		placeholder="Search sessions..."
		autocomplete="off"
		spellcheck={false}
		{value}
		onfocus={() => { focused = true; }}
		oninput={(event) => {
			focused = true;
			applyText(event.currentTarget.value, false);
		}}
		onkeydown={handleKeydown}
	/>
	{#if suggesting}
		<!-- The scope filters you can use, each with the token that types it.
		     Press events are cancelled so a tap never blurs the input first. -->
		<Surface
			variant="card"
			radius="panel"
			elevation="dropdown"
			class="absolute left-[-1px] right-[-1px] top-full z-[var(--z-dropdown)] mt-[6px] max-h-[60vh] overflow-y-auto py-[6px] font-brand"
			data-testid="session-scope-suggestions"
		>
			<div class="px-[14px] pt-[6px] pb-[5px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[0.1em] text-text-dimmer">Scope</div>
			{#if scopeQuery === ""}
				{@render option(null, "All projects", null)}
			{/if}
			{#each scopeOptions as project (project.slug)}
				{@render option(project.slug, project.title || project.slug, `project:${project.slug}`)}
			{:else}
				{#if scopeQuery !== ""}
					<div class="px-[14px] py-[8px] text-[12.5px] text-text-dimmer">No project matches “{scopeQuery}”</div>
				{/if}
			{/each}
		</Surface>
	{/if}
</div>

{#snippet option(slug: string | null, label: string, token: string | null)}
	<Button
		variant="ghost"
		size="content"
		tone="inherit"
		hoverFill="alt"
		class="flex min-h-[44px] w-full items-center gap-[12px] px-[14px] text-left text-[13.5px] md:min-h-[32px] md:text-[12.5px] {scope === slug ? 'text-text' : 'text-text-secondary'}"
		aria-pressed={scope === slug}
		data-testid="session-scope-option"
		onpointerdown={(event: PointerEvent) => event.preventDefault()}
		onmousedown={(event: MouseEvent) => event.preventDefault()}
		onclick={() => pickScope(slug)}
	>
		<span class="min-w-0 flex-1 truncate">{label}</span>
		{#if token}<span class="shrink-0 font-mono text-[11px] text-text-dimmer">{token}</span>{/if}
		{#if scope === slug}<Icon name="check" size={13} class="shrink-0 text-accent" />{/if}
	</Button>
{/snippet}

{#if editing}
	<ProjectDialog
		open
		project={editing}
		projects={projectState.projects}
		onclose={() => { editing = null; }}
		onsaved={applyProjectMutationResponse}
		returnFocus={() => scopeChip ?? null}
	/>
{/if}

<script lang="ts">
	import { onMount, tick, untrack } from "svelte";
	import { Schema } from "effect";
	import { BUILTIN_CATEGORIES, CategorySchema, CategorySetRejected, DEFAULT_CUSTOM_CATEGORY_WEIGHT, type Category, type CategorySet } from "../../../contracts/category-set.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { sessionMessages } from "../../stores/chat.svelte.js";
	import { getCurrentSessionId } from "../../stores/router.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";
	import CategoryPill from "../ui/CategoryPill.svelte";
	import SettingsBanner from "../ui/SettingsBanner.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import NumberStepper from "../ui/NumberStepper.svelte";
	import SurfacingCategoryEditor from "./SurfacingCategoryEditor.svelte";
	import SurfacingCategoryPreview from "./SurfacingCategoryPreview.svelte";
	import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";

	let { onPageChange, active: visible = false, revision = 0 }: { onPageChange: (page: { title: string; back: () => void } | null) => void; active?: boolean; revision?: number } = $props();
	let current = $state<CategorySet | null>(null);
	let draft = $state<readonly Category[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state("");
	let stale = $state(false);
	let editor = $state<{ category: Category; creating: boolean } | null>(null);
	let deleting = $state<string | null>(null);
	let reloadFailed = $state(false);
	let counts = $state<Readonly<Record<string, number>> | null>(null);
	let countsFailed = $state(false);
	let countRevision = $state(0);
	const sessionId = $derived(getCurrentSessionId());
	const sessionMessageCount = $derived(sessionId ? (findSession(sessionId)?.messageCount ?? sessionMessages.get(sessionId)?.messages.length ?? 0) : 0);
	const lastMessageId = $derived(sessionId ? sessionMessages.get(sessionId)?.messages.at(-1)?.uuid : undefined);
	const active = $derived(draft.filter((c) => !c.retired));
	const retired = $derived(draft.filter((c) => c.retired));
	const dirty = $derived(current !== null && JSON.stringify(draft) !== JSON.stringify(current.categories));
	const valid = $derived(draft.every((c) => Schema.is(CategorySchema)(c)) && active.length <= 20);
	const phoneEditor = $derived(sessionViewState.compact && editor !== null);

	onMount(() => { void load(); return () => onPageChange(null); });
	$effect(() => {
		if (revision > 0) untrack(() => {
			if (dirty) { stale = true; void reloadCurrent(); }
			else void load();
		});
	});
	$effect(() => {
		void countRevision;
		void sessionMessageCount;
		void lastMessageId;
		const id = sessionId;
		const set = { categories: $state.snapshot(draft) };
		counts = null;
		countsFailed = false;
		if (!visible || !current || !valid || !id) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			void rpc("CountSessionCategories", { sessionId: id, set }).then((result) => {
				if (!cancelled) counts = result;
			}).catch(() => { if (!cancelled) countsFailed = true; });
		}, 300);
		return () => { cancelled = true; clearTimeout(timer); };
	});

	async function load(): Promise<void> {
		loading = true;
		error = "";
		try { current = await rpc("GetCategorySet", {}); draft = current.categories; stale = false; }
		catch { error = "Could not load categories. Try again."; }
		finally { loading = false; }
	}
	function change(category: Category): void {
		if (saving) return;
		draft = draft.map((c) => c.id === category.id ? category : c);
	}
	function reset(category: Category): void {
		const shipped = BUILTIN_CATEGORIES.find((c) => c.id === category.id);
		if (shipped) change(shipped);
	}
	function changed(category: Category): boolean {
		const shipped = BUILTIN_CATEGORIES.find((c) => c.id === category.id);
		return shipped !== undefined && (category.weight !== shipped.weight || JSON.stringify(category.criteria) !== JSON.stringify(shipped.criteria));
	}
	async function closeEditor(): Promise<void> {
		editor = null;
		onPageChange(null);
		await tick();
		document.querySelector<HTMLElement>('[data-testid="surfacing-tab-categories"]')?.focus();
	}
	function openEditor(category?: Category): void {
		if (saving) return;
		const creating = category === undefined;
		editor = { creating, category: category ?? { id: "", origin: "custom", label: "", glyph: "", colour: "#2a9fd6", weight: DEFAULT_CUSTOM_CATEGORY_WEIGHT, retired: false, criteria: { what: "" } } };
		if (sessionViewState.compact) onPageChange({ title: category?.label ?? "Add category", back: () => { void closeEditor(); } });
		void tick().then(() => document.querySelector<HTMLElement>('[data-testid="surfacing-category-editor"] input, [data-testid="surfacing-category-editor"] textarea')?.focus());
	}
	function discard(): void {
		if (!current || saving || reloadFailed) return;
		draft = current.categories;
		stale = false;
		error = "";
		deleting = null;
	}
	async function reloadCurrent(): Promise<void> {
		try { current = await rpc("GetCategorySet", {}); reloadFailed = false; error = "Categories changed elsewhere"; }
		catch { reloadFailed = true; error = "Categories changed elsewhere. Could not reload the current set. Retry reload before discarding."; }
	}
	async function save(): Promise<void> {
		if (!current || saving || stale || !dirty || !valid || editor) return;
		saving = true;
		error = "";
		try {
			current = await rpc("ReplaceCategorySet", { expectedVersion: current.version, nextSet: { categories: draft } });
			messageSurfacing.categorySet = current;
			draft = current.categories;
		} catch (cause) {
			if (Schema.is(CategorySetRejected)(cause) && cause.reason === "stale_version") {
				stale = true;
				error = "Categories changed elsewhere";
				await reloadCurrent();
			} else error = failureLine(cause, "Could not save categories. Your draft is still here.");
		} finally { saving = false; }
	}
</script>

{#if loading}<p role="status">Loading categories…</p>
{:else if !current}
	<p role="alert" class="text-error">{error}</p><Button variant="settings" size="content" onclick={() => { void load(); }}>Retry</Button>
{:else}
	{#if error}
		<!-- Save sits at the bottom of a long list, so bring the outcome into view. -->
		<div role="alert" class="mb-3" {@attach (node) => node.scrollIntoView({ block: "nearest" })}><SettingsBanner tone="warning"><b>{error}</b>{#if stale}<p>The server has version {current.version}. Your draft is still shown. Discard to use the current categories before editing again.</p>{/if}</SettingsBanner></div>
		{#if reloadFailed}<Button variant="settings" size="content" onclick={() => { void reloadCurrent(); }}>Retry reload</Button>{/if}
	{/if}
	{#if !phoneEditor}
		<SurfacingCategoryPreview current={current} draft={{ categories: draft }} {valid} active={visible} />
		{#if sessionId && countsFailed}<p role="alert" class="mb-3 text-[12px] text-text-dimmer">Could not load session counts. <Button variant="ghost" size="sm" onclick={() => { countRevision++; }}>Retry counts</Button></p>{/if}
		<p class="mb-[12px] text-[12px] leading-[1.5] text-text-dimmer">Weight changes re-level every message at once, at no cost. Definition changes and new categories apply to messages judged from now on.</p>
	{/if}
	{#if editor}
		{#key editor}
			<SurfacingCategoryEditor category={editor.category} creating={editor.creating} persisted={current.categories.some((c) => c.id === editor?.category.id)} categories={draft} disabled={saving}
				onCancel={() => { void closeEditor(); }} onSave={(category) => {
					const edited = editor;
					if (!edited) return;
					draft = edited.creating ? [...draft, category] : draft.map((c) => c.id === edited.category.id ? category : c);
					void closeEditor();
				}} />
		{/key}
	{/if}
	{#if !phoneEditor}
		<SettingsGroup id="surfacing-active-categories" title={`${active.length} of 20 active`}>
			{#snippet actions()}<Button variant="settings" icon="plus" iconSize={13} size="sm" disabled={saving || editor !== null || active.length >= 20} data-testid="surfacing-category-add" onclick={() => openEditor()}>Add category</Button>{/snippet}
			{#each active as category (category.id)}
				<div class="category-row group grid grid-cols-[108px_minmax(0,1fr)_auto_90px] items-center gap-x-[10px] gap-y-2 px-[14px] py-[8px] max-md:grid-cols-[minmax(0,1fr)_auto]" data-testid={`surfacing-category-row-${category.id}`}>
					<CategoryPill {category} />
					<span class="line-clamp-2 text-[12.5px] leading-[1.35] text-text-secondary max-md:col-span-2 max-md:row-start-2">{category.criteria.what}</span>
					<div class="relative max-md:col-span-2 max-md:row-start-3">
						{#if sessionId}<span class="whitespace-nowrap font-mono text-[11px] text-text-dimmer" data-testid="surfacing-category-count">{counts?.[category.id] ?? "…"} here</span>{/if}
						<div class="category-actions flex flex-wrap items-center gap-1">
							{#if deleting === category.id}
								<span class="text-[12px]">Delete {category.glyph} {category.label}?</span>
								<Button variant="settings" tone="error" size="content" disabled={saving || editor !== null} onclick={() => { draft = draft.filter((c) => c.id !== category.id); deleting = null; }}>Delete</Button>
								<Button variant="ghost" size="sm" onclick={() => { deleting = null; }}>Cancel</Button>
							{:else}
								<Button variant="ghost" tone="accent" size="sm" disabled={saving || editor !== null} onclick={() => openEditor(category)} ariaLabel={category.origin === "builtin" ? `Edit ${category.label} definition` : `Edit ${category.label}`}>Edit</Button>
								{#if category.origin === "builtin"}
									<Button variant="ghost" tone="accent" size="sm" disabled={saving || editor !== null} onclick={() => change({ ...category, retired: true })}>Retire</Button>
									{#if changed(category)}<Button variant="ghost" tone="accent" size="sm" disabled={saving || editor !== null} ariaLabel={`Reset ${category.label}`} onclick={() => reset(category)}>↺</Button>{/if}
								{:else}<Button variant="ghost" tone="accent" size="sm" disabled={saving || editor !== null} onclick={() => { deleting = category.id; }}>Delete</Button>{/if}
							{/if}
						</div>
					</div>
					<div class="flex items-center justify-end gap-1 max-md:col-start-2 max-md:row-start-1">
						<NumberStepper label={`${category.label} weight`} value={category.weight} edited={current.categories.find((c) => c.id === category.id)?.weight !== category.weight} disabled={saving || editor !== null} onvaluechange={(weight) => change({ ...category, weight })} />
					</div>
				</div>
			{/each}
		</SettingsGroup>
		{#if retired.length}
			<SettingsGroup id="surfacing-retired-categories" title="Retired">
				{#each retired as category (category.id)}
					<div class="flex flex-wrap items-center gap-3 px-[14px] py-[8px]" data-testid={`surfacing-category-row-${category.id}`}>
						<CategoryPill {category} /><span class="min-w-0 flex-1 text-[12.5px]">{category.criteria.what}</span>
						{#if sessionId}<span class="whitespace-nowrap font-mono text-[11px] text-text-dimmer" data-testid="surfacing-category-count">{counts?.[category.id] ?? "…"} if restored</span>{/if}
						<Button variant="settings" size="content" disabled={saving || editor !== null || active.length >= 20} onclick={() => change({ ...category, retired: false })}>Restore</Button>
					</div>
				{/each}
			</SettingsGroup>
		{/if}
		{#if dirty || stale}
			<div class="sticky bottom-0 z-10 mt-[12px] flex flex-wrap items-center gap-2 rounded-[12px] bg-settings-bg p-[10px] ring-1 ring-border shadow-settings-dialog" data-testid="surfacing-draft-bar">
				<span class="min-w-0 flex-1 text-[12.5px]"><b>Unsaved.</b> Saving re-levels every card at once.</span>
				<Button variant="ghost" size="sm" disabled={saving || editor !== null || reloadFailed} onclick={discard}>Discard</Button>
				<Button variant="settings" tone="accent" size="content" disabled={saving || stale || !valid || editor !== null} onclick={() => { void save(); }}>Save</Button>
			</div>
		{/if}
	{/if}
{/if}

<style>
	/* Pointer devices reveal a row's actions on hover or focus, laid over the end of its definition. */
	@media (min-width: 768px) and (hover: hover) {
		.category-actions { display: none; position: absolute; right: 0; top: 50%; transform: translateY(-50%); padding-left: 8px; background: linear-gradient(var(--color-hover), var(--color-hover)), var(--color-settings-card); white-space: nowrap; flex-wrap: nowrap; }
		.category-row:hover .category-actions,
		.category-row:focus-within .category-actions,
		.category-actions:has(> span) { display: flex; }
		.category-row:hover,
		.category-row:focus-within { background: var(--color-hover); }
	}
</style>

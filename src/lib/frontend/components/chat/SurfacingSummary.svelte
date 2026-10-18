<script lang="ts">
	import type { Snippet } from "svelte";
	import { MediaQuery } from "svelte/reactivity";
	import type { MessageSurfacingPreferences } from "../../../contracts/message-surfacing.js";
	import type { TurnRecap } from "../../../contracts/turn-recap.js";
	import { SURFACE_LABELS, surfaceTime, type SurfaceLevel, type SurfaceTurn } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import Popover from "../ui/Popover.svelte";
	import SheetChrome from "../ui/SheetChrome.svelte";

	// jsdom has no matchMedia; real browsers always do.
	const media = typeof matchMedia === "function";
	const viewport = media ? new MediaQuery("(max-width: 599px)") : { current: false };
	const desktop = media ? new MediaQuery("(min-width: 1024px)") : { current: true };
	let { versions, selected, open, phone = viewport.current, live, view, start, settings, level = "balanced", plainCitations = false, generating = false, error = "", settingsError = "", saving = false, onclose, onversion, ongenerate, onretry, onsettings, oncite, onhover, foot }: {
		versions: readonly TurnRecap[];
		selected: TurnRecap | undefined;
		open: boolean;
		phone?: boolean;
		live: boolean;
		view: SurfaceTurn;
		start: number;
		settings: MessageSurfacingPreferences["recap"];
		level?: SurfaceLevel;
		plainCitations?: boolean;
		generating?: boolean;
		error?: string;
		settingsError?: string;
		saving?: boolean;
		onclose: () => void;
		onversion: (version: number) => void;
		ongenerate: (scope: "whole" | "new", sourceVersion?: number) => void;
		onretry: () => void;
		onsettings: (patch: Partial<MessageSurfacingPreferences["recap"]>) => void;
		oncite: (ordinal: number) => void;
		onhover?: (ordinal: number | null) => void;
		foot?: Snippet<[SurfaceTurn]> | undefined;
	} = $props();
	let followed = $state<number[]>([]);
	let readingOrdinal = $state<number | null>(null);
	let summaryEl: HTMLElement | undefined;
	let readerHeight = $state<number | undefined>();
	let citationTrigger: HTMLElement | null = null;
	const reading = $derived(view.numbers.find(({ number }) => number === readingOrdinal));
	const citationPopover = $derived(!phone && desktop.current);
	$effect(() => {
		void selected?.version;
		void open;
		readingOrdinal = null;
	});
	const latest = $derived(versions.at(-1));
	const newer = $derived(view.numbers.filter(({ number }) => number > (latest?.lastOrdinal ?? 0)).length);
	const index = $derived(versions.findIndex(({ version }) => version === selected?.version));
	const writtenAt = (recap: TurnRecap) => surfaceTime(recap.createdAt - start);
	const preceding = $derived(selected ? versions.filter(({ version, lastOrdinal }) => version < selected.version && lastOrdinal < selected.firstOrdinal).at(-1) : undefined);
	const previous = $derived(versions[index - 1]);
	const next = $derived(versions[index + 1]);
	const chunks = $derived(selected?.text.split(/(\[#\d+\])/g) ?? []);
	function cite(ordinal: number) {
		if (plainCitations) {
			if (phone) onclose();
			oncite(ordinal);
			return;
		}
		readerHeight = summaryEl?.parentElement?.getBoundingClientRect().height;
		readingOrdinal = ordinal;
		if (!followed.includes(ordinal)) followed = [...followed, ordinal];
		onhover?.(null);
		oncite(ordinal);
	}
	function closeCitation() {
		readingOrdinal = null;
		onhover?.(null);
		citationTrigger?.focus({ preventScroll: true });
	}
</script>

{#snippet citationButton(message: SurfaceTurn["numbers"][number], props: Record<string, unknown>)}
	<Button {...props} variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="recap-cite" data-testid="surfacing-recap-cite-{message.number}" data-unread={!plainCitations && message.part.surfacingRead === false} data-followed={!plainCitations && followed.includes(message.number)} data-ask={!plainCitations && view.openAsk?.uuid === message.part.uuid} ariaLabel={`#${message.number}${!plainCitations && message.part.surfacingRead === false ? ", unread" : ""}`} onpointerenter={() => onhover?.(message.number)} onpointerleave={() => onhover?.(null)} onfocus={() => onhover?.(message.number)} onblur={() => onhover?.(null)}>#{message.number}</Button>
{/snippet}

{#snippet citationReader()}
	{#if reading}
		<section class="summary-reader" data-testid="surfacing-recap-reader" data-ordinal={reading.number} aria-label={`Cited message #${reading.number}`}>
			<div class="reader-head"><span>#{reading.number} · {surfaceTime((reading.part.createdAt ?? start) - start)}</span><Button variant="ghost" size="content" tone="muted" touchTarget class="ml-auto size-[24px] rounded-full" ariaLabel="Close cited message" onclick={closeCitation}><Icon name="x" size={14} /></Button></div>
			{#if reading.belowLevel}<p class="reader-note">At {SURFACE_LABELS[reading.level]}, below {SURFACE_LABELS[level]} · opened directly</p>{/if}
			<div class="reader-body md-content">{@html reading.part.html}</div>
		</section>
	{/if}
{/snippet}

{#snippet content()}
	<div class="summary-reading" class:split={!phone && !citationPopover && !!reading} style:height={!phone && !citationPopover && reading && readerHeight !== undefined ? `${readerHeight}px` : undefined}>
	<section bind:this={summaryEl} class="summary" data-testid="surfacing-summary" aria-label={live ? "Summary so far" : "Turn summary"} aria-busy={generating}>
		<div class="summary-head">
			<Button variant="ghost" size="content" tone="inherit" touchTarget class="min-h-[28px] font-semibold gap-[5px] text-[13.5px]" ariaLabel="Close summary" onclick={onclose}>{#if !phone}<Icon name="chevron-down" size={14} class="text-text-muted" />{/if}✦ {live ? "Summary so far" : "Turn summary"}</Button>
			<Menu ariaLabel="Summary settings" side="bottom" align="start">
				{#snippet trigger({ props })}<Button {...props} variant="ghost" size="content" tone="inherit" touchTarget class="h-[24px] gap-[4px] rounded-full bg-chip px-[9px] text-[12px] font-medium text-text" data-testid="surfacing-summary-settings" ariaLabel="Summary settings">{settings.model === "opus" ? "Opus" : settings.model === "off" ? "Off" : "Sonnet"}<Icon name="chevron-down" size={12} /></Button>{/snippet}
				<p class="px-[8px] pt-[6px] text-[11px] text-text-muted">Summary model</p>
				<MenuRadioGroup value={settings.model}>
					{#each ["sonnet", "opus", "off"] as model}
						<MenuRadioItem value={model} disabled={saving} onselect={() => onsettings({ model: model === "opus" ? "opus" : model === "off" ? "off" : "sonnet" })}>{model === "opus" ? "Opus" : model === "off" ? "Off" : "Sonnet"}</MenuRadioItem>
					{/each}
				</MenuRadioGroup>
				<p class="px-[8px] pt-[10px] text-[11px] text-text-muted">Summary timing</p>
				<MenuRadioGroup value={settings.when}>
					<MenuRadioItem value="turn-end" disabled={saving} onselect={() => onsettings({ when: "turn-end" })}>When a turn ends</MenuRadioItem>
					<MenuRadioItem value="on-request" disabled={saving} onselect={() => onsettings({ when: "on-request" })}>On request</MenuRadioItem>
				</MenuRadioGroup>
				<p class="max-w-[240px] px-[8px] py-[8px] text-[11px] text-text-muted">Applies to every session · Settings › Surfacing</p>
			</Menu>
			{#if selected}
				<div class="versions" data-testid="surfacing-summary-version">
					{#if versions.length > 1}<Button variant="ghost" size="content" tone="muted" touchTarget class="size-[28px] rounded-full text-[18px]" ariaLabel="Previous summary" disabled={!previous || generating} onclick={() => previous && onversion(previous.version)}>‹</Button>{/if}
					<span class="scope">{selected.scope === "whole" ? "Whole turn" : `New since ${preceding ? writtenAt(preceding) : "start"}`} · {view.numbers.filter(({ number }) => number >= selected.firstOrdinal && number <= selected.lastOrdinal).length}</span>
					<span class="phone-stamp">{writtenAt(selected)}</span>
					{#if versions.length > 1}<Button variant="ghost" size="content" tone="muted" touchTarget class="size-[28px] rounded-full text-[18px]" ariaLabel="Next summary" disabled={!next || generating} onclick={() => next && onversion(next.version)}>›</Button>
					<span>{index + 1}/{versions.length}</span>{/if}
				</div>
			{/if}
			{#if newer > 0 && latest}<span class="new-count">· {newer} new</span>{/if}
		</div>
		{#if settingsError}<p role="alert" class="summary-error">{settingsError}</p>{/if}
		{#if error}
			<div role="alert">
				<div class="summary-fail"><Icon name="x" size={14} /><span>Summary failed</span><Button variant="ghost" size="content" tone="inherit" touchTarget class="ml-auto h-[26px] rounded-full bg-chip px-[12px] text-[13px] font-medium text-text" onclick={onretry}>Retry</Button></div>
				<p class="summary-error">{error}</p>
			</div>
		{:else if generating}
			<div class="summary-actions"><span class="summary-busy" role="status"><Icon name="loader-circle" size={13} class="animate-spin" />Summarising…</span></div>
		{:else if newer > 0 && latest || !selected}
			<div class="summary-actions">
				<Button variant="accent-soft" size="content" touchTarget class="h-[28px] rounded-full px-[12px] text-[13px] font-medium" data-testid="surfacing-summary-new" onclick={() => ongenerate(latest ? "new" : "whole")}>{latest ? `✦ Summarize ${newer} new · since ${writtenAt(latest)}` : `✦ Summarize ${live ? "so far" : "turn"} · ${view.numbers.length}`}</Button>
				{#if latest}<Button variant="ghost" size="content" tone="inherit" touchTarget class="h-[28px] rounded-full bg-chip px-[12px] text-[13px] font-medium text-text" ariaLabel="Whole turn" onclick={() => ongenerate("whole")}>↻ Whole turn</Button>{/if}
			</div>
		{/if}
		{#if selected}
			<p class="summary-prose" class:regenerating={generating}>
				{#each chunks as chunk}
					{@const ordinal = /^\[#(\d+)\]$/.exec(chunk)?.[1]}
					{@const message = ordinal ? view.numbers.find(({ number }) => number === Number(ordinal)) : undefined}
					{#if message}
						{#if citationPopover && !plainCitations}
							<Popover open={readingOrdinal === message.number} onopenchange={(nextOpen) => nextOpen ? cite(message.number) : closeCitation()} ariaLabel={`Cited message #${message.number}`} side="top" class="max-w-[380px]">
								{#snippet trigger({ props })}{@render citationButton(message, props)}{/snippet}
								{@render citationReader()}
							</Popover>
						{:else}
							{@render citationButton(message, { onclick: (event: MouseEvent) => { citationTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null; cite(message.number); } })}
						{/if}
					{:else if !ordinal}{chunk}{/if}
				{/each}
			</p>
			<div class="summary-foot">
				<span class="mr-auto"><span class="desk-only">{`${selected.model.charAt(0).toUpperCase()}${selected.model.slice(1)} · `}</span>{`${view.numbers.filter(({ number }) => number >= selected.firstOrdinal && number <= selected.lastOrdinal).length} updates`}<span class="desk-only">{` · ${(selected.durationMs / 1000).toFixed(1)}s`}</span>{" · "}<span class="desk-only">{"written at "}</span>{writtenAt(selected)}</span>
				{@render foot?.(view)}
				<Button variant="ghost" size="content" tone="secondary" touchTarget class="h-[24px] gap-[4px] rounded-full bg-chip px-[10px] font-sans text-[12px] font-medium" ariaLabel="Regenerate summary" disabled={generating} onclick={() => ongenerate(selected.scope, selected.version)}>↻<span class="desk-only">Regenerate</span></Button>
			</div>
		{/if}
	</section>
	{#if !phone && !citationPopover}{@render citationReader()}{/if}
	</div>
{/snippet}

{#snippet phoneCitation()}
	<div class="px-[20px]">{@render citationReader()}</div>
{/snippet}

{#if phone}
	<Dialog {open} {onclose} placement="sheet" ariaLabel={live ? "Summary so far" : "Turn summary"}>
		<SheetChrome bodyClass="px-[20px]" bottomPadding={24} footer={reading ? phoneCitation : undefined}>{@render content()}</SheetChrome>
	</Dialog>
{:else if open}
	{@render content()}
{/if}

<style>
	.summary-reading { display:flow-root; }
	.summary-reading.split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; padding-top:10px; }
	.split > .summary, .split > .summary-reader { min-height:0; overflow-y:auto; margin-top:0; }
	.summary-reader { margin-top:10px; padding:10px 12px; border:1px solid var(--color-border-subtle); border-radius:12px; background:var(--color-bg); }
	.reader-head { display:flex; align-items:center; gap:8px; color:var(--color-text-muted); font:12px var(--font-mono); }
	.reader-note { margin:6px 0; color:var(--color-text-muted); font-size:12px; }
	.reader-body { max-height:40dvh; overflow:auto; font-size:14px; line-height:1.65; overflow-wrap:anywhere; }
	.summary { margin-top:10px; padding:11px 14px 10px; border-radius:12px; background:var(--color-bg); }
	.summary-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
	.new-count { font:12px var(--font-mono); color:var(--color-accent); }
	.versions { margin-left:auto; display:flex; align-items:center; gap:4px; color:var(--color-text-muted); font:12px var(--font-mono); }
	.phone-stamp { display:none; }
	.summary-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
	.summary-prose { margin:10px 0 0; font-size:14px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; }
	.regenerating { opacity:.45; }
	.summary-prose :global(.recap-cite) { display:inline-flex; align-items:center; justify-content:center; margin-left:2px; padding:0 6px; border-radius:999px; background:var(--color-chip); color:var(--color-text-secondary); font:500 11px/18px var(--font-mono); vertical-align:1px; }
	.summary-prose :global([data-ask="true"]) { background:color-mix(in srgb,var(--color-status-ask) 18%,transparent); color:var(--color-status-ask); }
	.summary-prose :global([data-unread="true"]:not([data-ask="true"])) { background:color-mix(in srgb,var(--color-accent) 18%,transparent); color:var(--color-accent); }
	.summary-prose :global([data-followed="true"]) { outline:1px dashed currentColor; outline-offset:-1px; background:transparent; }
	.summary-prose :global(.recap-cite:hover), .summary-prose :global(.recap-cite:focus-visible) { background:var(--color-accent); color:var(--color-bg); }
	.summary-busy { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 12px; border-radius:999px; background:var(--color-chip); color:var(--color-text-secondary); font-size:13px; font-weight:500; }
	.summary-foot { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px; padding-top:9px; border-top:1px solid var(--color-border-subtle); color:var(--color-text-muted); font:11.5px var(--font-mono); }
	.summary-fail { display:flex; align-items:center; gap:8px; margin-top:10px; color:var(--color-error); font-size:13px; }
	.summary-error { margin:6px 0 0; color:var(--color-error); font-size:12px; overflow-wrap:anywhere; }
	@media(max-width:599px) {
		.summary { margin:0; padding:8px 0 0; background:transparent; }
		.summary-head { gap:4px; }
		.scope { display:none; }
		.phone-stamp { display:inline; }
		.summary-prose { font-size:15px; line-height:1.6; }
		.summary-foot { flex-wrap:nowrap; }
		.desk-only { display:none; }
	}
</style>

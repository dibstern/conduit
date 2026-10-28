<script lang="ts">
	import type { TurnPanelState } from "../../stores/turn-panel.svelte.js";
	import { assertNever } from "../../../utils.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { STOPS, type ShowStop, type StopCounts } from "../../utils/turn-stops.js";
	import type { TurnEconomics } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import RunningPill from "./RunningPill.svelte";

	let { panel, counts, bill, running, onlevelchange }: { panel: TurnPanelState; counts: StopCounts; bill: TurnEconomics; running: number; onlevelchange: () => void } = $props();
	const layout = $derived<"tabs" | "menu">(sessionViewState.compact && (panel.stops.length > 1 || panel.hasHandBacks) ? "menu" : "tabs");
	const active = $derived.by(() => {
		const view = panel.view;
		switch (view.kind) {
			case "collapsed": return null;
			case "open": {
				const tab = view.view;
				switch (tab.kind) {
					case "show": return tab.stop;
					case "qa": case "usage": return tab.kind;
					default: return assertNever(tab);
				}
			}
			default: return assertNever(view);
		}
	});
	const billDetail = $derived<"cost" | "context">(!sessionViewState.compact && panel.phase === "settled" ? "context" : "cost");
	const options = $derived([...(layout === "tabs" ? panel.stops : []).map((stop) => ({
		value: stop,
		label: panel.stops.length === 1 && stop === "log" ? STOPS.log.tab : STOPS[stop].short,
		...(stop === "log" && panel.stops.length > 1 ? { groupLabel: "Every step" } : {}),
	})), ...(layout === "tabs" && panel.hasHandBacks ? [{ value: "qa" as const, label: "Q&A", groupLabel: "Q&A" }] : []), { value: "usage" as const, label: "Usage", groupLabel: "Usage" }]);
	let defaultState = $state<{ kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string }>({ kind: "idle" });
	function show(stop: ShowStop) {
		panel.show(stop);
		if (stop !== "log") onlevelchange();
	}
	function resetLevel() {
		panel.resetLevel();
		onlevelchange();
	}
	async function makeDefault() {
		defaultState = { kind: "saving" };
		try { await panel.makeDefault(); defaultState = { kind: "idle" }; }
		catch { defaultState = { kind: "failed", message: "Couldn't save the default. Try again." }; }
	}
</script>

{#snippet stopContent(stop: ShowStop, label: string)}
	<span>{label}</span>{#if stop !== "final"}<small class="font-mono text-[10.5px] text-text-muted">{counts[stop]}</small>{/if}
	{#if panel.overridden && active === stop}<i class="size-[6px] rounded-full bg-accent" data-testid="surfacing-level-default-dot" title="Overrides the default level"></i>{/if}
{/snippet}

{#snippet defaults()}
	<Button variant="ghost" size="content" tone="muted" touchTarget class="px-[6px] text-[11.5px]" disabled={defaultState.kind === "saving"} onclick={makeDefault}>Make default</Button>
	<Button variant="ghost" size="content" tone="muted" touchTarget class="px-[6px] text-[11.5px]" disabled={!panel.overridden || defaultState.kind === "saving"} onclick={resetLevel}>Back to default</Button>
{/snippet}

<div data-testid="turn-show-bar" data-layout={layout} class="flex flex-wrap items-center gap-[4px] rounded-b-[13px] border-t border-border bg-turn-bg px-[12px]">
	{#if layout === "tabs"}
		{#if panel.stops.length > 1}<span class="mr-[4px] text-[11.5px] text-text-muted">Show</span>{/if}
	{:else}
		<Menu ariaLabel="Show, least to most" presentation="popover" side="bottom" align="start">
			{#snippet trigger({ props })}
				<Button {...props} variant="ghost" size="content" tone="secondary" touchTarget class="min-h-[36px] gap-[6px] text-[12px]" data-testid="surfacing-level" ariaLabel="Show messages">{active === "usage" || active === null ? "Show ⌄" : `Show · ${active === "qa" ? "Q&A" : STOPS[active].menu} ⌄`}{#if panel.overridden && active !== "usage" && active !== "qa"}<i class="size-[6px] rounded-full bg-accent" data-testid="surfacing-level-default-dot" title="Overrides the default level"></i>{/if}</Button>
			{/snippet}
			<MenuGroup label="Show, least to most">
				<MenuRadioGroup value={active}>
					{#each panel.stops as stop (stop)}
						{#if stop === "log"}<MenuSeparator />{/if}
						<MenuRadioItem value={stop} aria-label={STOPS[stop].menu} textValue={STOPS[stop].menu} indicatorPosition="leading" onselect={() => show(stop)}>
							<span class="flex items-center justify-between gap-[16px] font-medium">
								<span class="inline-flex items-center gap-[6px]">{STOPS[stop].menu}{#if panel.overridden && active === stop}<i class="size-[6px] rounded-full bg-accent" data-testid="surfacing-level-default-dot" title="Overrides the default level"></i>{/if}</span>
								{#if stop !== "final"}<small class="font-mono text-[10.5px] text-text-muted">{counts[stop]}</small>{/if}
							</span>
							<span class="block text-[10.5px] text-text-muted">{STOPS[stop].description}</span>
						</MenuRadioItem>
					{/each}
					{#if panel.hasHandBacks}<MenuSeparator /><MenuRadioItem value="qa" aria-label="Q&A" textValue="Q&A" indicatorPosition="leading" onselect={() => panel.qa()}>Q&A</MenuRadioItem>{/if}
				</MenuRadioGroup>
			</MenuGroup>
			{#if panel.stops.length > 1}
				<MenuSeparator />
				<MenuItem disabled={defaultState.kind === "saving"} onselect={makeDefault}>Make default</MenuItem>
				<MenuItem disabled={!panel.overridden || defaultState.kind === "saving"} onselect={resetLevel}>Back to default</MenuItem>
			{/if}
		</Menu>
	{/if}
	<Tabs variant="footer" value={active ?? ""} {options} label="Show" data-testid={layout === "tabs" && panel.stops.length > 1 ? "surfacing-level" : undefined} onValueChange={(stop) => { if (stop === "usage") panel.usage(); else if (stop === "qa") panel.qa(); else show(stop); }}>
		{#snippet optionContent(option)}{#if option.value === "usage"}Usage{:else if option.value === "qa"}Q&A{:else}{@render stopContent(option.value, option.label)}{/if}{/snippet}
	</Tabs>
	{#if layout === "tabs" && panel.stops.length > 1}{@render defaults()}{/if}
	<RunningPill count={running} />
	<span class="turn-meta ml-auto inline-flex items-center gap-[10px] whitespace-nowrap py-[6px] font-mono text-[11.5px] text-text-secondary">
		<span>{bill.cost === undefined ? "Cost unavailable" : `$${bill.cost.toFixed(billDetail === "context" ? 4 : 2)}`}</span>
		{#if billDetail === "context" && bill.context}<QuotaMeter used={bill.context.pct} caption={`${bill.context.pct}%`} labelPrefix="ctx" size="sm" gap={5} />{/if}
	</span>
	{#if defaultState.kind === "failed"}<p role="alert" class="w-full pb-[6px] text-[12px] text-error">{defaultState.message}</p>{/if}
</div>

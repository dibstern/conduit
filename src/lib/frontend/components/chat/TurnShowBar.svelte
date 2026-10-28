<script lang="ts">
	import type { TurnPanelState } from "../../stores/turn-panel.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { STOPS, type ShowStop, type StopCounts } from "../../utils/turn-stops.js";
	import type { TurnEconomics } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import RunningPill from "./RunningPill.svelte";

	let { panel, counts, bill, running, onlevelchange }: { panel: TurnPanelState; counts: StopCounts; bill: TurnEconomics; running: number; onlevelchange: () => void } = $props();
	const layout = $derived<"tabs" | "menu">(sessionViewState.compact && panel.stops.length > 1 ? "menu" : "tabs");
	const active = $derived(panel.view.kind === "open" && panel.view.view.kind === "show" ? panel.view.view.stop : "usage");
	const billDetail = $derived<"cost" | "context">(!sessionViewState.compact && panel.phase === "settled" ? "context" : "cost");
	const options = $derived([...(layout === "tabs" ? panel.stops : []).map((stop) => ({
		value: stop,
		label: panel.stops.length === 1 && stop === "log" ? STOPS.log.tab : STOPS[stop].short,
		...(stop === "log" && panel.stops.length > 1 ? { groupLabel: "Every step" } : {}),
	})), { value: "usage" as const, label: "Usage", groupLabel: "Usage" }]);
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
		<Menu ariaLabel="Show, least to most" side="top" align="start">
			{#snippet trigger({ props })}
				<Button {...props} variant="ghost" size="content" tone="secondary" touchTarget class="min-h-[36px] gap-[6px] text-[12px]" data-testid="surfacing-level" ariaLabel="Show messages">Show · {active === "usage" ? "" : STOPS[active].menu} ⌄{#if panel.overridden}<i class="size-[6px] rounded-full bg-accent" data-testid="surfacing-level-default-dot" title="Overrides the default level"></i>{/if}</Button>
			{/snippet}
			{#each panel.stops as stop (stop)}
				<MenuItem aria-label={STOPS[stop].short} aria-current={active === stop ? "true" : undefined} variant={active === stop ? "selected" : "default"} onselect={() => show(stop)}>{@render stopContent(stop, STOPS[stop].menu)}</MenuItem>
			{/each}
			<MenuItem disabled={defaultState.kind === "saving"} onselect={makeDefault}>Make default</MenuItem>
			<MenuItem disabled={!panel.overridden || defaultState.kind === "saving"} onselect={resetLevel}>Back to default</MenuItem>
		</Menu>
	{/if}
	<Tabs variant="footer" value={active} {options} label="Show" data-testid={layout === "tabs" && panel.stops.length > 1 ? "surfacing-level" : undefined} onValueChange={(stop) => { if (stop === "usage") panel.usage(); else show(stop); }}>
		{#snippet optionContent(option)}{#if option.value === "usage"}Usage{:else}{@render stopContent(option.value, option.label)}{/if}{/snippet}
	</Tabs>
	{#if layout === "tabs" && panel.stops.length > 1}{@render defaults()}{/if}
	<RunningPill count={running} />
	<span class="turn-meta ml-auto inline-flex items-center gap-[10px] whitespace-nowrap py-[6px] font-mono text-[11.5px] text-text-secondary">
		<span>{bill.cost === undefined ? "Cost unavailable" : `$${bill.cost.toFixed(billDetail === "context" ? 4 : 2)}`}</span>
		{#if billDetail === "context" && bill.context}<QuotaMeter used={bill.context.pct} caption={`${bill.context.pct}%`} labelPrefix="ctx" size="sm" gap={5} />{/if}
	</span>
	{#if defaultState.kind === "failed"}<p role="alert" class="w-full pb-[6px] text-[12px] text-error">{defaultState.message}</p>{/if}
</div>

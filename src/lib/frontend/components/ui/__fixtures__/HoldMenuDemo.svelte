<script lang="ts">
	import { onMount } from "svelte";
	import Button from "../Button.svelte";
	import HoldMenu from "../HoldMenu.svelte";
	import LabelledGridGroup from "../LabelledGridGroup.svelte";
	import Menu from "../Menu.svelte";
	import SheetFooter from "../SheetFooter.svelte";
	import SwitchRow from "../SwitchRow.svelte";
	import Tile from "../Tile.svelte";

	let { probe = false, scrollable = false, presentation = "sheet" }: { probe?: boolean; scrollable?: boolean; presentation?: "sheet" | "popover" } = $props();
	let open = $state(true);
	let picked = $state("");
	let picks = $state(0);
	let events = $state<Record<string, unknown>[]>([]);
	const choices = [
		{ id: "hour", label: "In 1 hour", detail: "10:41" },
		{ id: "three", label: "In 3 hours", detail: "12:41" },
		{ id: "evening", label: "This evening", detail: "6:00 pm" },
		{ id: "tomorrow", label: "Tomorrow", detail: "9:00 am" },
		{ id: "week", label: "Next week", detail: "Mon 9:00" },
		{ id: "pick", label: "Pick a date & time…", icon: "pencil", detail: "›", separated: true },
		{ id: "forever", label: "Until something happens", detail: "" },
	];
	const items = choices.map((choice) => ({ ...choice, action: () => { picked = choice.id; picks += 1; } }));

	onMount(() => {
		if (!probe) return;
		const record = (event: Event) => {
			const target = event.target instanceof Element ? event.target : null;
			const pointer = event instanceof PointerEvent ? event : null;
			// Read after dispatch so prevented touchmove and the final sheet position are recorded.
			queueMicrotask(() => {
				const menu = document.querySelector<HTMLElement>('[aria-label="Session actions"]');
				const trigger = document.querySelector<HTMLElement>("[data-hold-menu-trigger]");
				events = [...events.slice(-199), {
					time: Math.round(performance.now()), type: event.type,
					target: target?.getAttribute("data-hold-menu-item") ?? target?.getAttribute("data-testid") ?? target?.tagName,
					pointerId: pointer?.pointerId, pointerType: pointer?.pointerType,
					x: pointer?.clientX, y: pointer?.clientY, prevented: event.defaultPrevented,
					phase: trigger?.dataset["holdMenuPhase"], sheetOpen: open,
					scrollTop: menu?.querySelector("[data-sheet-body]")?.scrollTop,
					transform: menu?.style.transform, picked, picks,
				}];
			});
		};
		const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "touchmove", "scroll", "click"];
		for (const type of types) document.addEventListener(type, record, { capture: true, passive: true });
		return () => { for (const type of types) document.removeEventListener(type, record, true); };
	});

	function download() {
		const url = URL.createObjectURL(new Blob([JSON.stringify({ userAgent: navigator.userAgent, at: new Date().toISOString(), events }, null, 2)], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "hold-menu-device-probe.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
</script>

<output data-testid="hold-menu-picked" class="sr-only">{picked}</output>
<output data-testid="hold-menu-picks" class="sr-only">{picks}</output>
{#if probe}<output data-testid="hold-menu-probe-json" class="sr-only">{JSON.stringify(events)}</output>{/if}
{#if probe}
	<div class="p-[12px] text-[13px] text-text">
		<p>Record the screen. Tap, hold and slide to choose, release off-list, tap dimmed content, then swipe up from Snooze. Export this log after closing the sheet.</p>
		<Button onclick={download}>Export device probe</Button>
		<output data-testid="hold-menu-probe-count" class="sr-only">{events.length} events · {picks} picks · {picked}</output>
	</div>
{/if}

{#snippet footer()}
	<SheetFooter actions={[
		{ label: "Share", icon: "share", onselect: () => { picked = "share"; } },
		{ label: "Settings", icon: "settings", onselect: () => { picked = "settings"; } },
		{ label: "Debug", icon: "bug", tag: "dev", onselect: () => { picked = "debug"; } },
	]} />
{/snippet}

<Menu bind:open {presentation} ariaLabel="Session actions" {footer} class={presentation === "sheet" ? "min-h-[85dvh] [&_[data-sheet-body]]:flex-1" : "w-[340px]"}>
	{#snippet trigger({ props })}<Button {...props}>Open session actions</Button>{/snippet}
	{#snippet children()}
		<div class="px-[16px]">
			<div data-testid="hold-menu-header" class="py-[12px]">
				<p class="text-[16px] font-semibold">Typed session list</p>
				<p class="mt-[4px] text-[12px] text-text-dimmer">conduit · feat/typed-session-list · 12m ago</p>
			</div>
			<div data-hold-menu-dim data-testid="hold-menu-views" class="grid grid-cols-3 gap-[8px] py-[8px]">
				{#each ["Chat", "Terminal", "Diff"] as view (view)}<div class="rounded-[10px] bg-chip p-[12px] text-center text-[13px]">{view}</div>{/each}
			</div>
			<LabelledGridGroup label="Triage">
				<Tile icon="check" label="Settle" variant="primary" />
				<HoldMenu title="Snooze until" hint="slide to a time, let go" {items}>
					{#snippet trigger({ props, held })}<Tile icon="moon" label="Snooze" tag="hold" {held} triggerProps={props} />{/snippet}
				</HoldMenu>
				<Tile icon="pin" label="Pin" />
				<Tile icon="circle-dot" label="Unread" />
			</LabelledGridGroup>
			<SwitchRow checked label="Auto-settle" description="settles Sat 4:12 pm if left idle" class="mt-[10px]" />
			<LabelledGridGroup label="Session">
				<Tile icon="pencil" label="Rename" />
				<Tile icon="git-fork" label="Fork" />
				<Tile icon="copy" label="Copy resume" />
				<Tile icon="trash-2" label="Delete…" variant="danger" />
			</LabelledGridGroup>
			{#if scrollable}
				{#each Array.from({ length: 8 }, (_, i) => i) as i (i)}
					<LabelledGridGroup label={`More actions ${i + 1}`}><Tile icon="folder" label={`Archive ${i + 1}`} /></LabelledGridGroup>
				{/each}
			{/if}
		</div>
	{/snippet}
</Menu>

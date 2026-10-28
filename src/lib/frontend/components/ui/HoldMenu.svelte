<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import { createAttachmentKey } from "svelte/attachments";
	import { hold } from "../../actions/hold.js";
	import Icon from "./Icon.svelte";

	type HoldMenuState =
		| { phase: "closed" }
		| { phase: "pressing"; pointerId: number }
		| { phase: "following"; pointerId: number; highlighted: string | null }
		| { phase: "open" };

	let { title, hint, icon = "moon", items, trigger, activation = "hold" }: {
		title: string;
		hint: string;
		icon?: string;
		activation?: "hold" | "click" | undefined;
		items: readonly { id: string; label: string; icon?: string; detail?: string; separated?: boolean; selected?: boolean; action: (event: Event) => void }[];
		trigger: Snippet<[{ props: Record<string, unknown>; held: boolean; following: boolean }]>;
	} = $props();

	let gestureState = $state<HoldMenuState>({ phase: "closed" });
	let triggerNode = $state<HTMLElement | null>(null);
	let menuNode = $state<HTMLElement | null>(null);
	let anchorNode = $state<HTMLElement | null>(null);
	let panelNode = $state<HTMLElement | null>(null);
	let notchOffset = $state(0);
	let holdSide = $state<"top" | "bottom">("bottom");
	const panelId = $props.id();
	const attachmentKey = createAttachmentKey();
	const open = $derived(gestureState.phase === "open" || gestureState.phase === "following");
	const following = $derived(gestureState.phase === "following");
	$effect(() => {
		if (open) measure();
	});

	function measure() {
		if (!triggerNode || !anchorNode) return;
		const trigger = triggerNode.getBoundingClientRect();
		const anchor = anchorNode.getBoundingClientRect();
		notchOffset = trigger.left + trigger.width / 2 - anchor.left + 4;
		// Keep a heading and at least one 38px option below the finger.
		holdSide = anchor.bottom + 12 + 44 + 38 <= window.innerHeight ? "bottom" : "top";
	}

	function itemAt(event: PointerEvent) {
		const row = triggerNode?.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-hold-menu-item]");
		return row && panelNode?.contains(row) ? row : null;
	}

	function attachTrigger(node: HTMLElement) {
		triggerNode = node;
		menuNode = node.closest<HTMLElement>("[data-dropdown-menu-content]");
		anchorNode = node.closest<HTMLElement>("[data-menu-grid]") ?? node;
		const observer = new ResizeObserver(measure);
		observer.observe(anchorNode);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const cleanup = () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
		measure();
		if (activation === "click") return cleanup;
		const action = hold(node, {
			followPointer: true,
			keyboard: false,
			onPress: (event) => {
				if (!open) gestureState = { phase: "pressing", pointerId: event.pointerId };
			},
			onHold: (event) => {
				if (!event) return;
				gestureState = { phase: "following", pointerId: event.pointerId, highlighted: null };
				node.ownerDocument.defaultView?.navigator.vibrate?.(10);
			},
			onMove: (event) => {
				if (gestureState.phase !== "following") return;
				gestureState = { ...gestureState, highlighted: itemAt(event)?.dataset["holdMenuItem"] ?? null };
			},
			onRelease: () => {
				if (gestureState.phase !== "following") return;
				// Pick what the finger last highlighted: some drivers report the lift at (0,0).
				const { highlighted } = gestureState;
				const row = highlighted === null ? null : panelNode?.querySelector<HTMLElement>(`[data-hold-menu-item="${CSS.escape(highlighted)}"]`);
				gestureState = { phase: "open" };
				// Use the same selection and root dismissal as a normal bits-ui click.
				row?.click();
			},
			onCancel: () => {
				gestureState = { phase: gestureState.phase === "following" || open ? "open" : "closed" };
			},
		});
		return () => { cleanup(); action.destroy(); };
	}

	function closeList(event: Event) {
		event.preventDefault();
		event.stopPropagation();
		gestureState = { phase: "closed" };
		triggerNode?.focus();
	}
</script>

<DropdownMenu.Sub open={open} onOpenChange={(next) => { gestureState = { phase: next ? "open" : "closed" }; }}>
	<DropdownMenu.SubTrigger>
		{#snippet child({ props })}
			{@render trigger({ props: {
				...props,
				// Tap/hold opens this submenu. Keep bits-ui's keyboard handlers.
				onpointermove: undefined,
				onpointerleave: undefined,
				"data-hold-menu-trigger": "",
				"data-hold-menu-activation": activation,
				"data-hold-menu-phase": gestureState.phase,
				[attachmentKey]: attachTrigger,
			}, held: open, following })}
		{/snippet}
	</DropdownMenu.SubTrigger>
	{#if menuNode}
		<!-- Keep the dismiss layer inside the parent menu's dismissal boundary. -->
		<DropdownMenu.Portal to={activation === "click" ? "body" : menuNode}>
			{#if open && activation === "hold"}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div aria-hidden="true" data-hold-menu-dismiss class="absolute inset-0 z-[var(--z-raised)]" onpointerdown={(event) => { event.preventDefault(); event.stopPropagation(); }} onpointerup={closeList} onclick={closeList}></div>
			{/if}
			<DropdownMenu.SubContent
				id={panelId}
				aria-label={title}
				side={activation === "click" ? "bottom" : holdSide} align="start" sideOffset={12} alignOffset={-4}
				customAnchor={anchorNode} strategy="fixed" avoidCollisions={activation === "click"} collisionPadding={activation === "click" ? 8 : 0}
				preventOverflowTextSelection={false}
				onInteractOutside={(event) => {
					if (activation === "hold" && event.target instanceof Node && menuNode?.contains(event.target)) event.preventDefault();
				}}
				onOpenAutoFocus={(event) => { if (following) event.preventDefault(); }}
			>
				{#snippet child({ props, wrapperProps })}
					<div {...wrapperProps}>
						<div {...props} id={panelId} bind:this={panelNode} data-hold-menu-panel style:--hold-menu-notch={`${notchOffset}px`} class="hold-menu-panel relative z-[var(--z-popover)] w-[calc(var(--bits-menu-anchor-width)+8px)] rounded-[16px] bg-popover-bg px-[6px] pt-[4px] pb-[6px] text-text {activation === 'click' ? 'shadow-popover' : 'shadow-dropdown'} ring-1 ring-border-chip outline-hidden">
							<div class="flex items-center gap-[7px] px-[10px] pt-[8px] pb-[6px] text-[13px] font-semibold">
								<span aria-hidden="true" class="text-status-snoozed"><Icon name={icon} size={14} /></span>{title}
								{#if following}<small class="ml-auto text-[11.5px] font-normal text-text-dimmer">{hint}</small>{/if}
							</div>
							<div class="flex max-h-[calc(var(--bits-menu-content-available-height)-44px)] flex-col overflow-y-auto overscroll-contain">
							{#each items as item (item.id)}
								<DropdownMenu.Item textValue={item.label} onSelect={item.action} data-hold-menu-item={item.id} data-selected={activation === "click" && item.selected || undefined} aria-current={activation === "click" && item.selected ? "true" : undefined} data-followed={gestureState.phase === "following" && gestureState.highlighted === item.id || undefined}>
									{#snippet child({ props })}
										<div {...props} class={["hold-menu-row relative flex min-h-[32px] cursor-pointer select-none items-center gap-[10px] rounded-[10px] px-[10px] text-[14.5px] outline-hidden", following ? "h-[38px]" : "h-[32px]", item.separated && "mt-[7px] before:absolute before:inset-x-[10px] before:-top-[4px] before:border-t before:border-border-chip before:content-['']"]}>
											<span aria-hidden="true" class="hold-menu-icon text-text-dimmer"><Icon name={item.icon ?? "clock"} size={14} /></span>{item.label}
											{#if item.detail}<small class="hold-menu-detail ml-auto font-mono text-[12px] text-text-dimmer">{item.detail}</small>{/if}
										</div>
									{/snippet}
								</DropdownMenu.Item>
							{/each}
							</div>
						</div>
					</div>
				{/snippet}
			</DropdownMenu.SubContent>
		</DropdownMenu.Portal>
	{/if}
</DropdownMenu.Sub>

<style>
	.hold-menu-panel::before {
		content: "";
		position: absolute;
		top: -6px;
		left: calc(var(--hold-menu-notch) - 6px);
		width: 12px;
		height: 12px;
		background: var(--color-popover-bg);
		box-shadow: -1px -1px 0 var(--color-border-chip);
		transform: rotate(45deg);
	}
	.hold-menu-panel[data-side="top"]::before {
		top: auto;
		bottom: -6px;
		box-shadow: 1px 1px 0 var(--color-border-chip);
	}
	.hold-menu-row:is([data-highlighted], [data-followed], [data-selected]) {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
		color: var(--color-accent);
	}
	.hold-menu-row:is([data-highlighted], [data-followed], [data-selected]) :global(:is(.hold-menu-icon, .hold-menu-detail)) { color: inherit; }
	:global([data-hold-menu-trigger][aria-expanded="true"]) { position: relative; z-index: var(--z-dropdown); }
	:global([data-hold-menu-trigger][data-hold-menu-phase="open"]) { scale: 1; }
	:global([data-dropdown-menu-content]:has([data-hold-menu-trigger][data-hold-menu-activation="hold"][aria-expanded="true"])) :global(:is([data-hold-menu-dim], [data-menu-tile]:not([data-hold-menu-trigger]), [data-menu-switch-row], [data-dropdown-menu-group-heading], [data-sheet-footer])) { opacity: .28; }
	@media (prefers-reduced-motion: reduce) {
		:global([data-hold-menu-trigger]) { scale: 1; transform: none; transition: none; }
	}
</style>

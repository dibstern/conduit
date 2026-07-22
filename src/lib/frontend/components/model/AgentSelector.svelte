<!-- ─── Agent Selector ──────────────────────────────────────────────────────── -->
<!-- Provider-scoped dropdown picker for switching agents. -->

<script lang="ts">
	import { tick } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import {
		buildAgentTooltip,
		discoveryState,
		getActiveAgent,
		getVisibleAgents,
		formatAgentLabel,
	} from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { switchAgentRpc } from "../../transport/ws-rpc-client.js";
	import type { AgentInfo } from "../../types.js";

	// ─── State ──────────────────────────────────────────────────────────────────

	let dropdownOpen = $state(false);
	let triggerEl: HTMLButtonElement | undefined = $state();
	let portalEl: HTMLDivElement | undefined = $state();
	let highlightedIndex = $state(0);
	let portalStyle = $state("");

	const VIEWPORT_MARGIN = 8;
	const TRIGGER_GAP = 4;
	const MIN_WIDTH = 224;
	const MAX_HEIGHT = 360;
	const MIN_HEIGHT = 96;

	// ─── Derived ────────────────────────────────────────────────────────────────

	/** Visible agents — global hide-list applied (server filters subagents). */
	const visibleAgents = $derived(getVisibleAgents());
	const providerName = $derived(
		discoveryState.agentProviderScope?.name ?? "Provider",
	);
	const providerHeading = $derived(`${providerName} agents`);

	/** Effective active agent — falls back to first visible when activeAgentId is null. */
	const effectiveAgent = $derived(
		getActiveAgent() ?? visibleAgents[0],
	);
	const shouldHide = $derived(visibleAgents.length === 1);

	/** Display name for the trigger button. */
	const displayName = $derived.by(() => {
		if (effectiveAgent) return displayLabel(effectiveAgent);
		return "Agent";
	});

	// ─── Helpers ────────────────────────────────────────────────────────────────

	/** Capitalize agent name if all lowercase. */
	function displayLabel(agent: AgentInfo): string {
		const label = formatAgentLabel(agent);
		if (label === label.toLowerCase()) {
			return label.charAt(0).toUpperCase() + label.slice(1);
		}
		return label;
	}

	function isActive(agent: AgentInfo): boolean {
		return agent.id === (discoveryState.activeAgentId ?? visibleAgents[0]?.id);
	}

	function isHighlighted(index: number): boolean {
		return index === highlightedIndex;
	}

	function agentItemClass(agent: AgentInfo, index: number): string {
		const base =
			"agent-item flex items-center gap-2 w-full py-1.5 px-3.5 m-0 border-none bg-transparent text-text text-sm text-left cursor-pointer transition-colors duration-100 leading-[1.35] hover:bg-bg font-brand";
		const activeClass = isActive(agent) ? " text-accent" : "";
		const highlightedClass = isHighlighted(index) ? " bg-bg" : "";
		return `${base}${activeClass}${highlightedClass}`;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), Math.max(min, max));
	}

	function updatePortalPosition() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const availableWidth = Math.max(160, window.innerWidth - VIEWPORT_MARGIN * 2);
		const width = Math.min(Math.max(MIN_WIDTH, rect.width), availableWidth);
		const left = clamp(
			rect.left,
			VIEWPORT_MARGIN,
			window.innerWidth - width - VIEWPORT_MARGIN,
		);
		const availableAbove = Math.max(
			0,
			rect.top - VIEWPORT_MARGIN - TRIGGER_GAP,
		);
		const availableBelow = Math.max(
			0,
			window.innerHeight - rect.bottom - VIEWPORT_MARGIN - TRIGGER_GAP,
		);
		const placeAbove =
			availableAbove >= Math.min(MAX_HEIGHT, availableBelow) ||
			availableAbove >= availableBelow;
		const availableHeight = placeAbove ? availableAbove : availableBelow;
		const maxHeight = Math.max(
			MIN_HEIGHT,
			Math.min(MAX_HEIGHT, availableHeight || MIN_HEIGHT),
		);
		const verticalPosition = placeAbove
			? `bottom:${window.innerHeight - rect.top + TRIGGER_GAP}px;`
			: `top:${rect.bottom + TRIGGER_GAP}px;`;

		portalStyle = `position:fixed;left:${left}px;${verticalPosition}width:${width}px;max-height:${maxHeight}px;overflow-y:auto;z-index:9999;`;
	}

	function portal(node: HTMLElement) {
		if (typeof document === "undefined") return {};
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}

	function highlightedRow(): HTMLElement | null {
		return (
			portalEl?.querySelector<HTMLElement>(
				`[data-agent-index="${highlightedIndex}"]`,
			) ?? null
		);
	}

	function scrollHighlightedIntoView() {
		highlightedRow()?.scrollIntoView?.({ block: "nearest" });
	}

	// ─── Handlers ───────────────────────────────────────────────────────────────

	async function open() {
		const activeIndex = visibleAgents.findIndex((agent) => isActive(agent));
		highlightedIndex = activeIndex >= 0 ? activeIndex : 0;
		dropdownOpen = true;
		await tick();
		updatePortalPosition();
		scrollHighlightedIntoView();
	}

	function close() {
		dropdownOpen = false;
		portalEl = undefined;
	}

	function toggleDropdown(e: MouseEvent) {
		e.stopPropagation();
		if (dropdownOpen) {
			close();
		} else {
			open();
		}
	}

	function handleAgentClick(agent: AgentInfo) {
		if (agent.id !== discoveryState.activeAgentId) {
			const previousAgentId = discoveryState.activeAgentId;
			discoveryState.activeAgentId = agent.id;
			const projectSlug = getCurrentSlug();
			const sessionId = sessionState.currentId;
			if (projectSlug && sessionId) {
				void switchAgentRpc({
					projectSlug,
					sessionId,
					agentId: agent.id,
				}).catch(() => {
					discoveryState.activeAgentId = previousAgentId;
				});
			}
		}
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!dropdownOpen) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		if (visibleAgents.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightedIndex = (highlightedIndex + 1) % visibleAgents.length;
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightedIndex =
				(highlightedIndex - 1 + visibleAgents.length) % visibleAgents.length;
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const agent = visibleAgents[highlightedIndex];
			if (agent) handleAgentClick(agent);
		}
	}

	function handleOutsideClick(e: MouseEvent) {
		if (!dropdownOpen) return;
		const target = e.target as HTMLElement;
		if (triggerEl?.contains(target)) return;
		if (portalEl?.contains(target)) return;
		close();
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	$effect(() => {
		if (!dropdownOpen) return;
		updatePortalPosition();
		document.addEventListener("click", handleOutsideClick);
		document.addEventListener("keydown", handleKeydown);
		window.addEventListener("resize", updatePortalPosition);
		window.addEventListener("scroll", updatePortalPosition, true);
		return () => {
			document.removeEventListener("click", handleOutsideClick);
			document.removeEventListener("keydown", handleKeydown);
			window.removeEventListener("resize", updatePortalPosition);
			window.removeEventListener("scroll", updatePortalPosition, true);
		};
	});

	$effect(() => {
		if (!dropdownOpen) return;
		highlightedIndex;
		void tick().then(scrollHighlightedIntoView);
	});
</script>

<div id="agent-selector" class:hidden={shouldHide}>
	<button
		bind:this={triggerEl}
	class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary font-brand"
		title="Switch agent"
		onclick={toggleDropdown}
		aria-haspopup="listbox"
		aria-expanded={dropdownOpen}
	>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap">
			{displayName}
		</span>
		<Icon name="chevron-down" size={10} class="shrink-0 opacity-50" />
	</button>
</div>

{#if dropdownOpen}
	<div
		bind:this={portalEl}
		use:portal
		data-testid="agent-dropdown"
		class="agent-dropdown-panel max-w-[calc(100vw-16px)] bg-bg-alt border border-border rounded-lg shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] py-1.5 font-brand"
		style={portalStyle}
		role="listbox"
		aria-label={providerHeading}
	>
		<div class="px-3.5 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-[0.5px] text-text-dimmer">
			{providerHeading}
		</div>

		{#if visibleAgents.length === 0}
			<div class="py-4 px-3.5 text-center text-sm text-text-dimmer">
				No {providerName} agents available
			</div>
		{:else}
			{#each visibleAgents as agent, index (agent.id)}
				<button
					role="option"
					aria-selected={isActive(agent)}
					data-agent-id={agent.id}
					data-agent-index={index}
					class={agentItemClass(agent, index)}
					title={buildAgentTooltip(agent)}
					onclick={() => handleAgentClick(agent)}
					onmouseenter={() => {
						highlightedIndex = index;
					}}
				>
					<span class="w-[12px] shrink-0 text-accent font-bold text-xs">
						{#if isActive(agent)}&#10003;{/if}
					</span>
					<span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
						{displayLabel(agent)}
					</span>
					{#if agent.model}
						<span
							data-testid="agent-model-badge"
							class="ml-auto shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] leading-none text-text-dimmer"
						>
							{agent.model}
						</span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
{/if}

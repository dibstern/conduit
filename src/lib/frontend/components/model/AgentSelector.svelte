<!-- ─── Agent Selector ──────────────────────────────────────────────────────── -->
<!-- Dropdown picker for switching between OpenCode agents. -->
<!-- Uses a body-level portal so the dropdown escapes all ancestor clipping. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import {
		discoveryState,
		getActiveAgent,
		formatAgentLabel,
	} from "../../stores/discovery.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import type { AgentInfo } from "../../types.js";

	// ─── State ──────────────────────────────────────────────────────────────────

	let dropdownOpen = $state(false);
	let triggerEl: HTMLButtonElement | undefined = $state();
	let portalEl: HTMLDivElement | undefined = $state();

	// ─── Derived ────────────────────────────────────────────────────────────────

	/** Visible agents — server already filters out hidden/subagent agents. */
	const visibleAgents = $derived(discoveryState.agents);

	/** Effective active agent — falls back to first visible when activeAgentId is null. */
	const effectiveAgent = $derived(
		getActiveAgent() ?? visibleAgents[0],
	);
	const shouldHide = $derived(visibleAgents.length <= 1);

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

	/** Position the portal dropdown above the trigger button. */
	function positionPortal() {
		if (!triggerEl || !portalEl) return;
		const rect = triggerEl.getBoundingClientRect();
		portalEl.style.position = "fixed";
		portalEl.style.left = `${rect.left}px`;
		portalEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		portalEl.style.zIndex = "9999";
	}

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function open() {
		dropdownOpen = true;
		// Create portal container on body
		portalEl = document.createElement("div");
		portalEl.id = "agent-dropdown-portal";
		document.body.appendChild(portalEl);

		// Build dropdown content
		portalEl.innerHTML = buildDropdownHTML();
		positionPortal();

		// Attach click handlers to items
		for (const btn of portalEl.querySelectorAll<HTMLButtonElement>("[data-agent-id]")) {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const agentId = btn.dataset.agentId;
				if (!agentId) return;
				const agent = visibleAgents.find((a) => a.id === agentId);
				if (agent) handleAgentClick(agent);
			});
		}
	}

	function close() {
		dropdownOpen = false;
		if (portalEl) {
			portalEl.remove();
			portalEl = undefined;
		}
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
			wsSend({ type: "switch_agent", agentId: agent.id });
			discoveryState.activeAgentId = agent.id;
		}
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && dropdownOpen) {
			close();
		}
	}

	function handleOutsideClick(e: MouseEvent) {
		if (!dropdownOpen) return;
		const target = e.target as HTMLElement;
		if (triggerEl?.contains(target)) return;
		if (portalEl?.contains(target)) return;
		close();
	}

	/** Build dropdown HTML string for portal injection. */
	function buildDropdownHTML(): string {
		if (visibleAgents.length === 0) {
			return `<div style="position:fixed; z-index:9999;" class="w-56 max-w-[90vw] bg-bg-alt border border-border rounded-xl shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] py-1.5">
				<div class="py-4 px-3.5 text-center text-[13px] text-text-dimmer">No agents available</div>
			</div>`;
		}
		const items = visibleAgents
			.map((agent) => {
				const active = isActive(agent);
				const check = active
					? '<span style="color:var(--color-accent);font-weight:bold">&#10003; </span>'
					: "";
				const desc = agent.description
					? `<span style="display:block;font-size:10px;color:var(--color-text-dimmer);line-height:1.3;margin-top:2px">${escapeHtml(agent.description)}</span>`
					: "";
				const activeStyle = active ? "color:var(--color-accent);" : "";
				return `<button data-agent-id="${escapeAttr(agent.id)}" style="display:flex;align-items:baseline;gap:8px;width:100%;padding:6px 14px;margin:0;border:none;background:transparent;color:var(--color-text);font-family:var(--font-brand);font-size:13px;text-align:left;cursor:pointer;line-height:1.4;${activeStyle}" onmouseenter="this.style.background='var(--color-bg-alt)'" onmouseleave="this.style.background='transparent'">
					<span style="flex:1;min-width:0">
						<span style="display:flex;align-items:center;gap:4px">${check}${escapeHtml(displayLabel(agent))}</span>
						${desc}
					</span>
				</button>`;
			})
			.join("");
		return `<div class="agent-dropdown-panel" style="width:14rem;max-width:90vw;background:var(--color-bg-alt);border:1px solid var(--color-border);border-radius:12px;box-shadow:0 -4px 24px rgba(var(--shadow-rgb),0.4);padding:6px 0">${items}</div>`;
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function escapeAttr(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("click", handleOutsideClick);
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("click", handleOutsideClick);
			document.removeEventListener("keydown", handleKeydown);
			// Clean up portal on unmount
			if (portalEl) {
				portalEl.remove();
				portalEl = undefined;
			}
		};
	});
</script>

<div id="agent-selector" class:hidden={shouldHide}>
	<button
		bind:this={triggerEl}
		class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary"
		style="font-family: var(--font-brand);"
		title="Switch agent"
		onclick={toggleDropdown}
	>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap">
			{displayName}
		</span>
		<Icon name="chevron-down" size={10} class="shrink-0 opacity-50" />
	</button>
</div>

<!--
  TerminalPanel — Collapsible bottom panel with tabbed terminal interface.
  Contains a tab bar (with new/close buttons) and a body area where
  TerminalTab instances render XTerm.js terminals.
  Each TerminalTab handles its own resize via ResizeObserver.
-->
<script lang="ts">
	import { tick } from "svelte";
	import {
		terminalState,
		getTabList,
		getCanCreateTab,
		beginCreateTab,
		failCreateTab,
		handlePtyDeleted,
		switchTab,
		renameTab,
		closePanel,
	} from "../../stores/terminal.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { closePtyRpc, createPtyRpc, resizePtyRpc } from "../../transport/ws-rpc-client.js";
	import TerminalTab from "./TerminalTab.svelte";

	// ─── Props ────────────────────────────────────────────────────────────────

	let { onTabBarTouchStart }: { onTabBarTouchStart?: (e: TouchEvent) => void } = $props();

	// ─── Reactive derived state ────────────────────────────────────────────────

	const tabs = $derived(getTabList());
	const canCreate = $derived(getCanCreateTab());
	const activeTabId = $derived(terminalState.activeTabId);
	const statusMessage = $derived(terminalState.statusMessage);
	const panelOpen = $derived(terminalState.panelOpen);

	// ─── Rename state ──────────────────────────────────────────────────────────

	let renamingPtyId: string | null = $state(null);
	let renameValue: string = $state("");
	let renameInputEl: HTMLInputElement | null = $state(null);
	let tabListEl: HTMLDivElement | null = $state(null);

	// ─── Font size state ──────────────────────────────────────────────────────

	const FONT_SIZE_MIN = 6;
	const FONT_SIZE_MAX = 24;
	const FONT_SIZE_DEFAULT = 13;
	const FONT_SIZE_STEP = 1;
	const FONT_SIZE_STORAGE_KEY = "terminal-font-size";

	let termFontSize = $state(
		Number(
			typeof localStorage !== "undefined" &&
				localStorage.getItem(FONT_SIZE_STORAGE_KEY),
		) || FONT_SIZE_DEFAULT,
	);

	function decreaseFontSize() {
		const next = Math.max(FONT_SIZE_MIN, termFontSize - FONT_SIZE_STEP);
		if (next !== termFontSize) {
			termFontSize = next;
			persistFontSize();
		}
	}

	function increaseFontSize() {
		const next = Math.min(FONT_SIZE_MAX, termFontSize + FONT_SIZE_STEP);
		if (next !== termFontSize) {
			termFontSize = next;
			persistFontSize();
		}
	}

	function persistFontSize() {
		try {
			localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(termFontSize));
		} catch {
			/* ignore */
		}
	}

	function handleFontSizeResize(size: { cols: number; rows: number }) {
		const projectSlug = getCurrentSlug();
		if (activeTabId && projectSlug) {
			void resizePtyRpc({
				projectSlug,
				ptyId: activeTabId,
				originId: getBrowserClientId(),
				cols: size.cols,
				rows: size.rows,
			}).catch(() => undefined);
		}
	}

	// ─── Actions ───────────────────────────────────────────────────────────────

	function handleNewTab() {
		const projectSlug = getCurrentSlug();
		if (!projectSlug || !beginCreateTab()) return;
		void createPtyRpc({
			projectSlug,
			originId: getBrowserClientId(),
		}).catch(() => {
			failCreateTab("Failed to create terminal");
		});
	}

	function handleCloseTab(ptyId: string) {
		const projectSlug = getCurrentSlug();
		if (projectSlug) {
			void closePtyRpc({ projectSlug, ptyId }).catch(() => undefined);
		}
		handlePtyDeleted({ type: "pty_deleted", ptyId });
	}

	/**
	 * A `role="tab"` has presentational children, so the close affordance cannot be
	 * a nested button. It is an `aria-hidden` glyph handled here by hit-testing the
	 * click target; keyboard users close the focused tab with Delete/Backspace.
	 */
	function handleTabClick(e: MouseEvent, ptyId: string) {
		if ((e.target as Element).closest(".term-tab-close")) {
			handleCloseTab(ptyId);
			return;
		}
		switchTab(ptyId);
	}

	function handleTabKeydown(e: KeyboardEvent, ptyId: string) {
		switch (e.key) {
			case "Enter":
			case " ":
				e.preventDefault();
				switchTab(ptyId);
				return;
			case "Delete":
			case "Backspace":
				e.preventDefault();
				handleCloseTab(ptyId);
				return;
			case "ArrowLeft":
			case "ArrowRight": {
				e.preventDefault();
				const index = tabs.findIndex((tab) => tab.ptyId === ptyId);
				const step = e.key === "ArrowRight" ? 1 : -1;
				const next = tabs[(index + step + tabs.length) % tabs.length];
				if (!next || next.ptyId === ptyId) return;
				switchTab(next.ptyId);
				void tick().then(() => {
					tabListEl
						?.querySelector<HTMLElement>(`[data-pty-id="${next.ptyId}"]`)
						?.focus();
				});
				return;
			}
		}
	}

	function handleClosePanel() {
		closePanel();
	}

	// ─── Double-click rename ───────────────────────────────────────────────────

	function startRename(ptyId: string, currentTitle: string) {
		renamingPtyId = ptyId;
		renameValue = currentTitle;
		// Focus the input after Svelte renders it
		tick().then(() => {
			renameInputEl?.focus();
			renameInputEl?.select();
		});
	}

	function commitRename() {
		if (renamingPtyId) {
			const newTitle = renameValue.trim() || "Terminal";
			renameTab(renamingPtyId, newTitle);
		}
		renamingPtyId = null;
		renameValue = "";
	}

	function cancelRename() {
		renamingPtyId = null;
		renameValue = "";
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}
</script>

{#if panelOpen}
	<div
		id="terminal-panel"
		class="term-panel flex flex-col h-full bg-bg-surface border border-border rounded-lg overflow-hidden"
	>
		<!-- Tab bar -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="term-tab-bar flex items-center gap-0 px-1 bg-bg border-b border-border shrink-0 overflow-x-auto min-h-9"
			ontouchstart={onTabBarTouchStart}
		>
			<!-- Tab buttons -->
			<div
				bind:this={tabListEl}
				class="flex items-center shrink-0"
				role="tablist"
				aria-label="Terminal sessions"
			>
				{#each tabs as tab (tab.ptyId)}
					<div
						class="term-tab group flex items-center gap-1 py-1.5 px-2.5 text-xs font-sans cursor-pointer whitespace-nowrap border-b-2 transition-[color,background,border-color] duration-100 shrink-0 max-[480px]:py-[5px] max-[480px]:px-2 max-[480px]:text-sm
							{tab.ptyId === activeTabId
							? 'term-tab-active text-text border-b-accent bg-bg-surface'
							: 'text-text-muted border-transparent hover:text-text-secondary hover:bg-bg-alt'}
							{tab.exited ? 'term-tab-exited opacity-55 italic' : ''}"
						data-pty-id={tab.ptyId}
						role="tab"
						tabindex={tab.ptyId === activeTabId ? 0 : -1}
						aria-selected={tab.ptyId === activeTabId}
						onclick={(e) => handleTabClick(e, tab.ptyId)}
						ondblclick={() => startRename(tab.ptyId, tab.title)}
						onkeydown={(e) => handleTabKeydown(e, tab.ptyId)}
					>
						<!-- Label (editable on double-click) -->
						{#if renamingPtyId === tab.ptyId}
							<input
								bind:this={renameInputEl}
								bind:value={renameValue}
								class="term-rename-input bg-transparent border-none outline-none text-xs text-text font-sans w-[100px] p-0"
								type="text"
								aria-label="Rename terminal"
								onblur={commitRename}
								onkeydown={handleRenameKeydown}
								onclick={(e) => e.stopPropagation()}
							/>
						{:else}
							<span
								class="term-tab-label overflow-hidden text-ellipsis max-w-[120px] max-[480px]:max-w-[80px]"
							>
								{tab.title}
							</span>
						{/if}

						<!-- Close affordance: see handleTabClick -->
						<span
							class="term-tab-close shrink-0 w-[18px] h-[18px] border-none rounded bg-transparent text-text-muted text-sm leading-none cursor-pointer flex items-center justify-center transition-[color] duration-100 hover:text-error hover:bg-error/[0.08]"
							title="Close terminal"
							aria-hidden="true"
						>
							&times;
						</span>
					</div>
				{/each}
			</div>

			<!-- New Terminal button -->
			{#if canCreate}
				<button
					class="term-new-btn shrink-0 py-1 px-2.5 ml-0.5 border-none rounded bg-transparent text-accent font-sans text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-100 hover:bg-accent-bg hover:text-accent-hover max-[480px]:py-[3px] max-[480px]:px-2 max-[480px]:text-sm"
					title="New terminal"
					onclick={handleNewTab}
				>
					+ Terminal
				</button>
			{/if}

			<!-- Font size controls (right-aligned) -->
			<div class="flex items-center gap-0 ml-auto shrink-0">
				<button
					class="term-font-btn shrink-0 py-0.5 px-1.5 border-none rounded bg-transparent text-text-dimmer font-mono text-sm cursor-pointer transition-[color,background] duration-100 hover:text-text hover:bg-bg-alt disabled:opacity-30 disabled:cursor-default"
					title="Decrease font size"
					aria-label="Decrease font size"
					disabled={termFontSize <= FONT_SIZE_MIN}
					onclick={decreaseFontSize}
				>
					&#8722;
				</button>
				<span class="text-xs text-text-dimmer font-mono tabular-nums min-w-[2ch] text-center select-none">{termFontSize}</span>
				<button
					class="term-font-btn shrink-0 py-0.5 px-1.5 border-none rounded bg-transparent text-text-dimmer font-mono text-sm cursor-pointer transition-[color,background] duration-100 hover:text-text hover:bg-bg-alt disabled:opacity-30 disabled:cursor-default"
					title="Increase font size"
					aria-label="Increase font size"
					disabled={termFontSize >= FONT_SIZE_MAX}
					onclick={increaseFontSize}
				>
					+
				</button>
			</div>

			<!-- Close panel button -->
			<button
				class="term-close-panel-btn shrink-0 py-1 px-2 border-none rounded bg-transparent text-text-dimmer text-sm cursor-pointer transition-[color] duration-100 hover:text-text"
				title="Close terminal panel"
				aria-label="Close terminal panel"
				onclick={handleClosePanel}
			>
				&#215;
			</button>
		</div>

		<!-- Terminal body area -->
		<div class="term-body flex-1 relative overflow-hidden bg-code-bg">
			{#each tabs as tab (tab.ptyId)}
				<TerminalTab
					ptyId={tab.ptyId}
					active={tab.ptyId === activeTabId}
					fontSize={termFontSize}
					onFontSizeResize={handleFontSizeResize}
				/>
			{/each}
		</div>

		<!-- Status message -->
		{#if statusMessage}
			<div
				class="term-status py-1.5 px-3 text-xs text-accent bg-accent-bg text-center shrink-0"
			>
				{statusMessage}
			</div>
		{/if}
	</div>
{/if}

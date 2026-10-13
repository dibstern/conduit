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
		getPendingTabTitle,
		getCanCreateTab,
		beginCreateTab,
		failCreateTab,
		handlePtyRemove,
		switchTab,
		renameTab,
		closePanel,
	} from "../../stores/terminal.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { terminalAccountId } from "../layout/chrome-actions.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { closePtyRpc, createPtyRpc, resizePtyRpc } from "../../transport/ws-rpc-client.js";
	import type { GetFileTreeResponse } from "../../transport/ws-rpc.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import Surface from "../ui/Surface.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { onTabBarTouchStart, folders = [] }: {
		onTabBarTouchStart?: (e: TouchEvent) => void;
		folders?: GetFileTreeResponse["roots"];
	} = $props();

	const tabs = $derived(getTabList());
	const pendingTitle = $derived(getPendingTabTitle());
	const canCreate = $derived(getCanCreateTab());
	const activeTabId = $derived(terminalState.activeTabId);
	const statusMessage = $derived(terminalState.statusMessage);
	const panelOpen = $derived(terminalState.panelOpen);

	let renamingPtyId: string | null = $state(null);
	let renameValue: string = $state("");
	let renameInputEl = $state<HTMLInputElement>();
	let tabListEl: HTMLDivElement | null = $state(null);

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

	function stepFontSize(steps: number) {
		const next = Math.min(
			FONT_SIZE_MAX,
			Math.max(FONT_SIZE_MIN, termFontSize + steps * FONT_SIZE_STEP),
		);
		if (next === termFontSize) return;
		termFontSize = next;
		try {
			localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(termFontSize));
		} catch {
			/* ignore */
		}
	}

	// Pinch input is measured in Chromium's trackpad-pinch wheel units,
	// deltaY = -100·ln(scale), so trackpads and touchscreens step alike:
	// one font step per ~10% change in pinch scale.
	const PINCH_STEP_DELTA = 10;

	/**
	 * Pinch over the terminal steps the font size. Trackpad pinch arrives as a
	 * ctrl+wheel (Chromium, Firefox, and Safari since WebKit r277772); touch pinch
	 * as two-finger touches. Elsewhere the browser keeps its own pinch behaviour.
	 */
	function pinchFontSize(node: HTMLElement) {
		let pending = 0;
		let pinchDistance = 0;

		function zoomBy(delta: number) {
			pending += delta;
			const steps = Math.trunc(pending / PINCH_STEP_DELTA);
			pending -= steps * PINCH_STEP_DELTA;
			if (steps !== 0) stepFontSize(steps);
		}

		function onWheel(e: WheelEvent) {
			if (!e.ctrlKey) return;
			e.preventDefault();
			// Captured before xterm, which would scroll or send arrow keys.
			e.stopPropagation();
			// Line or page deltas (a mouse wheel in Firefox) count as one step, and a
			// ctrl+mouse-wheel notch (~100px) is capped there, like the +/- buttons.
			const delta =
				e.deltaMode === WheelEvent.DOM_DELTA_PIXEL
					? -e.deltaY
					: -Math.sign(e.deltaY) * PINCH_STEP_DELTA;
			zoomBy(Math.max(-PINCH_STEP_DELTA, Math.min(PINCH_STEP_DELTA, delta)));
		}

		// One-finger swipes stay with TerminalTab's scrollback handler.
		function onTouch(e: TouchEvent) {
			const a = e.touches.item(0);
			const b = e.touches.item(1);
			const distance =
				e.touches.length === 2 && a && b
					? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
					: 0;
			if (distance > 0 && e.type === "touchmove") {
				// Stops the page zooming: iOS ignores the viewport's user-scalable=no.
				e.preventDefault();
				if (pinchDistance > 0) zoomBy(100 * Math.log(distance / pinchDistance));
			}
			pinchDistance = distance;
		}

		// Safari starts its own page zoom from GestureEvents.
		const preventPageZoom = (e: Event) => e.preventDefault();

		const listeners = new AbortController();
		const { signal } = listeners;
		node.addEventListener("wheel", onWheel, { signal, passive: false, capture: true });
		node.addEventListener("touchstart", onTouch, { signal, passive: true });
		node.addEventListener("touchmove", onTouch, { signal, passive: false });
		node.addEventListener("touchend", onTouch, { signal, passive: true });
		node.addEventListener("touchcancel", onTouch, { signal, passive: true });
		node.addEventListener("gesturestart", preventPageZoom, { signal });
		node.addEventListener("gesturechange", preventPageZoom, { signal });
		return () => listeners.abort();
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

	function handleNewTab(root?: string) {
		const projectSlug = getCurrentSlug();
		const sessionId = getCurrentSessionId();
		const accountId = terminalAccountId();
		if (!projectSlug || !beginCreateTab()) return;
		void createPtyRpc({
			projectSlug,
			originId: getBrowserClientId(),
			...(sessionId ? { sessionId } : {}),
			...(accountId === undefined ? {} : { accountId }),
			...(root === undefined ? {} : { root }),
		}).catch(() => {
			failCreateTab("Failed to create terminal");
		});
	}

	function handleCloseTab(ptyId: string) {
		const projectSlug = getCurrentSlug();
		if (projectSlug) {
			void closePtyRpc({ projectSlug, ptyId }).catch(() => undefined);
		}
		handlePtyRemove({ id: ptyId });
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
	<Surface
		variant="card"
		radius="md"
		id="terminal-panel"
		class="term-panel flex flex-col h-full overflow-hidden"
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
							<!--
								`chrome="bare"` and `size="content"` go together: the
								affordance here is the tab around the field, so the
								field paints nothing and sizes itself. Dropped from the
								class list: `bg-transparent`, `border-none` and `p-0`,
								all three of which Tailwind v4's preflight already does
								on an input and which only squatted on their utility
								group.

								`focus-only` rather than `bare`: this field is only
								reachable by double-clicking a tab and is autofocused on
								appear, so with no focus indicator a keyboard user had no
								way to tell the edit box was live. A text input always
								matches `:focus-visible` while focused, so the inset
								outline shows the moment the field appears -- which is the
								point.
							-->
							<TextInput
								bind:element={renameInputEl}
								bind:value={renameValue}
								chrome="focus-only"
								size="content"
								class="term-rename-input text-xs text-text font-sans w-[100px]"
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
				{#if pendingTitle}
					<!--
						The terminal being created. Not a tab yet: until the server
						creates it there is nothing to select or close. The empty
						slot keeps the width of the close glyph, so nothing shifts
						when the real tab replaces it.
					-->
					<div
						class="term-tab-pending flex items-center gap-1 py-1.5 px-2.5 text-xs font-sans whitespace-nowrap border-b-2 shrink-0 text-text-dimmer max-[480px]:py-[5px] max-[480px]:px-2 max-[480px]:text-sm
							{activeTabId === null ? 'border-b-accent bg-bg-surface' : 'border-transparent'}"
						aria-hidden="true"
					>
						<span class="overflow-hidden text-ellipsis max-w-[120px] max-[480px]:max-w-[80px]">
							{pendingTitle}
						</span>
						<span class="w-[18px] h-[18px] shrink-0"></span>
					</div>
				{/if}
			</div>

			<!-- New Terminal button -->
			{#if canCreate}
				<!--
					`hoverFill="accent-bg"` is new to the union:
					the label is already accent-coloured, so a neutral wash reads as
					the label dimming rather than the row lighting up.
					`hover:text-accent-hover` stays in `class` because no tone member
					pairs a hover colour with `text-accent`, and a `hover:` variant
					outranks the unprefixed `text-accent` it comes from anyway.
				-->
				<Button
					variant="ghost"
					size="content"
					tone="accent"
					hoverFill="accent-bg"
					class="term-new-btn shrink-0 py-1 px-2.5 ml-0.5 rounded font-sans text-xs font-medium duration-100 hover:text-accent-hover max-[480px]:py-[3px] max-[480px]:px-2 max-[480px]:text-sm"
					title="New terminal"
					onclick={() => handleNewTab()}
				>
					+ Terminal
				</Button>
				{#if folders.length > 1}
					<Menu ariaLabel="New terminal in folder" side="top" align="start" class="max-w-[calc(100vw-16px)]">
						{#snippet trigger({ props })}
							<Button
								{...props}
								variant="ghost"
								size="content"
								tone="accent"
								hoverFill="accent-bg"
								icon="chevron-down"
								iconSize={14}
								iconOnly
								ariaLabel="New terminal in folder"
								data-testid="new-terminal-folder-picker"
								class="shrink-0 py-1 px-2 rounded max-[480px]:py-[3px]"
							/>
						{/snippet}
						{#each folders as folder (folder.root)}
							<MenuItem
								data-testid="new-terminal-folder-item"
								title={folder.root}
								onselect={() => handleNewTab(folder.root)}
							>
								<span class="truncate">{folder.label}</span>
							</MenuItem>
						{/each}
					</Menu>
				{/if}
			{/if}

			<!-- Font size controls (right-aligned) -->
			<div class="flex items-center gap-0 ml-auto shrink-0">
				<Button
					variant="ghost"
					size="content"
					tone="dimmer"
					hoverFill="alt"
					disabledStyle="faint"
					class="term-font-btn shrink-0 py-0.5 px-1.5 rounded font-mono text-sm duration-100"
					title="Decrease font size"
					ariaLabel="Decrease font size"
					disabled={termFontSize <= FONT_SIZE_MIN}
					onclick={() => stepFontSize(-1)}
				>
					&#8722;
				</Button>
				<span class="text-xs text-text-dimmer font-mono tabular-nums min-w-[2ch] text-center select-none" data-testid="terminal-font-size">{termFontSize}</span>
				<Button
					variant="ghost"
					size="content"
					tone="dimmer"
					hoverFill="alt"
					disabledStyle="faint"
					class="term-font-btn shrink-0 py-0.5 px-1.5 rounded font-mono text-sm duration-100"
					title="Increase font size"
					ariaLabel="Increase font size"
					disabled={termFontSize >= FONT_SIZE_MAX}
					onclick={() => stepFontSize(1)}
				>
					+
				</Button>
			</div>

			<!-- Close panel button -->
			<TextButton
				tone="dimmer" class="term-close-panel-btn shrink-0 py-1 px-2 rounded text-sm transition-[color] duration-100"
				title="Close terminal panel"
				aria-label="Close terminal panel"
				onclick={handleClosePanel}
			>
				&#215;
			</TextButton>
		</div>

		<!-- Terminal body area -->
		<div class="term-body flex-1 relative overflow-hidden bg-code-bg" {@attach pinchFontSize}>
			{#if pendingTitle && activeTabId === null}
				<p class="term-starting p-2 font-mono text-xs text-text-dimmer" role="status">
					Starting terminal…
				</p>
			{/if}
			<!-- xterm is large, so it loads when the panel first opens. -->
			{#await import("./TerminalTab.svelte") then { default: TerminalTab }}
				{#each tabs as tab (tab.ptyId)}
					<TerminalTab
						ptyId={tab.ptyId}
						active={tab.ptyId === activeTabId}
						fontSize={termFontSize}
						onFontSizeResize={handleFontSizeResize}
					/>
				{/each}
			{/await}
		</div>

		<!-- Status message -->
		{#if statusMessage}
			<div
				class="term-status py-1.5 px-3 text-xs text-accent bg-accent-bg text-center shrink-0"
			>
				{statusMessage}
			</div>
		{/if}
	</Surface>
{/if}

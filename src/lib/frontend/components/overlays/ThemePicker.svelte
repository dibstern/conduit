<script lang="ts">
	import type { Base16Theme } from "../../stores/theme-compute.js";
	import {
		themeState,
		getThemeLists,
		applyTheme,
		closeThemePicker,
	} from "../../stores/theme.svelte.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import { routerState } from "../../stores/router.svelte.js";

	let pickerEl = $state<HTMLDivElement>();

	const lists = $derived(getThemeLists());

	const SWATCH_KEYS = [
		"base00",
		"base01",
		"base09",
		"base0B",
		"base0D",
	] as const;

	function handleClickOutside(e: MouseEvent) {
		if (pickerEl && !pickerEl.contains(e.target as Node)) {
			closeThemePicker();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			closeThemePicker();
		}
	}

	function selectTheme(id: string) {
		applyTheme(id);
	}

	$effect(() => {
		if (themeState.pickerOpen) {
			setTimeout(() => {
				document.addEventListener("click", handleClickOutside);
				document.addEventListener("keydown", handleKeydown);
			}, 0);
		}
		return () => {
			document.removeEventListener("click", handleClickOutside);
			document.removeEventListener("keydown", handleKeydown);
		};
	});

	// Close theme picker when sidebar collapses
	$effect(() => {
		if (uiState.sidebarCollapsed && themeState.pickerOpen) {
			closeThemePicker();
		}
	});

	// Close theme picker on navigation (route change)
	$effect(() => {
		// Read routerState.path to track it
		const _path = routerState.path;
		// Don't close on first render — only on subsequent path changes
		return () => {
			if (themeState.pickerOpen) {
				closeThemePicker();
			}
		};
	});
</script>

{#snippet themeButton(id: string, theme: Base16Theme)}
	<button
		class="theme-picker-item"
		class:active={themeState.currentThemeId === id}
		onclick={() => selectTheme(id)}
		role="option"
		aria-selected={themeState.currentThemeId === id}
	>
		<div class="theme-swatches">
			{#each SWATCH_KEYS as key}
				<span
					class="theme-swatch"
					style="background:#{theme[key]}"
				></span>
			{/each}
		</div>
		<span class="theme-picker-label">{theme.name}</span>
		{#if themeState.currentThemeId === id}
			<span class="theme-picker-check">✓</span>
		{/if}
	</button>
{/snippet}

{#snippet themeSection(header: string, items: Array<{ id: string; theme: Base16Theme }>)}
	{#if items.length > 0}
		<div class="theme-picker-section">
			<div class="theme-picker-header">{header}</div>
			{#each items as { id, theme }}
				{@render themeButton(id, theme)}
			{/each}
		</div>
	{/if}
{/snippet}

{#if themeState.pickerOpen}
	<div
		bind:this={pickerEl}
		class="theme-picker"
		role="listbox"
		aria-label="Select theme"
	>
		{@render themeSection("Dark", lists.dark)}
		{@render themeSection("Light", lists.light)}
		{@render themeSection("Custom", lists.custom)}
	</div>
{/if}

<style>
	.theme-picker {
		position: fixed;
		bottom: 56px;
		left: 8px;
		width: 260px;
		max-height: 400px;
		overflow-y: auto;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 4px;
		z-index: 1000;
		box-shadow: 0 4px 24px rgba(var(--shadow-rgb, 0, 0, 0), 0.15);
		animation: theme-picker-in 0.15s ease-out;
	}

	@keyframes theme-picker-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.theme-picker-header {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		padding: 8px 8px 4px;
		position: sticky;
		top: 0;
		background: var(--color-bg);
	}

	.theme-picker-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		background: transparent;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-align: left;
	}

	.theme-picker-item:hover {
		background: var(--color-bg-alt);
	}

	.theme-picker-item.active {
		color: var(--color-text);
		font-weight: 500;
	}

	.theme-swatches {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}

	.theme-swatch {
		width: 12px;
		height: 12px;
		border-radius: 2px;
		border: 1px solid rgba(var(--overlay-rgb, 0, 0, 0), 0.1);
	}

	.theme-picker-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.theme-picker-check {
		color: var(--color-success);
		font-size: 14px;
		flex-shrink: 0;
	}
</style>

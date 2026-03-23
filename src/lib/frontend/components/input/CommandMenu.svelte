<!-- ─── Command Menu ──────────────────────────────────────────────────────── -->
<!-- Slash-command autocomplete popup. Filters commands by prefix match, supports -->
<!-- keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse selection. -->
<!-- Preserves #command-menu wrapper ID for E2E compatibility. -->

<script lang="ts">
	import type { CommandInfo } from "../../types.js";
	import { filterCommands } from "../../stores/discovery.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		query,
		visible,
		commands,
		onSelect,
		onClose,
	}: {
		query: string;
		visible: boolean;
		commands: CommandInfo[];
		onSelect: (command: string) => void;
		onClose: () => void;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let activeIndex = $state(0);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const filtered = $derived(
		[...filterCommands(commands, query)].sort((a, b) =>
			a.name.localeCompare(b.name),
		),
	);

	const isVisible = $derived(visible && filtered.length > 0);

	// ─── Reset active index when filtered list changes ──────────────────────────

	$effect(() => {
		// Depend on filtered.length to reset on filter change
		void filtered.length;
		activeIndex = 0;
	});

	// ─── Keyboard handling ──────────────────────────────────────────────────────

	export function handleKeydown(e: KeyboardEvent): boolean {
		if (!isVisible) return false;

		switch (e.key) {
			case "ArrowDown": {
				e.preventDefault();
				if (filtered.length > 0) {
					activeIndex = (activeIndex + 1) % filtered.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "ArrowUp": {
				e.preventDefault();
				if (filtered.length > 0) {
					activeIndex =
						(activeIndex - 1 + filtered.length) % filtered.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "Tab":
			case "Enter": {
				e.preventDefault();
				const selected = filtered[activeIndex];
				if (filtered.length > 0 && selected) {
					selectCommand(selected);
				}
				return true;
			}

			case "Escape": {
				e.preventDefault();
				onClose();
				return true;
			}

			default:
				return false;
		}
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function selectCommand(cmd: CommandInfo): void {
		onSelect(`/${cmd.name} `);
	}

	function scrollActiveIntoView(): void {
		// Use tick-like scheduling to wait for DOM update
		requestAnimationFrame(() => {
			const menu = document.querySelector("#command-menu .cmd-menu");
			const activeItem = menu?.querySelector(".cmd-item-active");
			if (activeItem) {
				activeItem.scrollIntoView({ block: "nearest" });
			}
		});
	}
</script>

<div id="command-menu" class:hidden={!isVisible}>
	{#if isVisible}
		<div
			class="cmd-menu absolute bottom-full left-0 right-0 mb-1 bg-bg-surface border border-border rounded-xl shadow-[0_-4px_16px_rgba(var(--shadow-rgb),0.3)] max-h-[300px] overflow-y-auto z-[60] py-1"
		>
			{#each filtered as cmd, i}
				<div
					class="cmd-item flex items-baseline gap-2 py-2 px-3.5 cursor-pointer transition-colors duration-100 max-sm:py-1.5 max-sm:px-2.5 max-sm:gap-1.5 {i === activeIndex ? 'cmd-item-active bg-accent-bg hover:bg-accent-bg' : 'hover:bg-bg-alt'}"
					data-cmd-index={i}
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					onmousedown={(e) => {
						e.preventDefault();
						selectCommand(cmd);
					}}
					onmouseenter={() => {
						activeIndex = i;
					}}
				>
					<span
						class="cmd-name shrink-0 font-mono text-base font-medium text-accent whitespace-nowrap max-sm:text-xs"
					>
					/{cmd.name}
					{#if cmd.args}
						<span class="cmd-args font-normal text-text-muted"
							>{cmd.args}</span
						>
					{/if}
				</span>
				{#if cmd.description}
					<span
						class="cmd-desc flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-base text-text-muted max-sm:text-xs"
					>
						{cmd.description}
						</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- ─── Command Menu ──────────────────────────────────────────────────────── -->
<!-- Slash-command autocomplete popup. Filters commands by prefix match, supports -->
<!-- keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse selection. -->
<!-- Preserves #command-menu wrapper ID for E2E compatibility. -->

<script lang="ts">
	import type { CommandInfo } from "../../types.js";
	import { filterCommands } from "../../stores/discovery.svelte.js";
	import DetachedListbox from "../ui/DetachedListbox.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		listboxId,
		query,
		visible,
		commands,
		onSelect,
		onClose,
		activeIndex = $bindable(0),
	}: {
		listboxId: string;
		query: string;
		visible: boolean;
		commands: CommandInfo[];
		onSelect: (command: string) => void;
		onClose: () => void;
		activeIndex?: number | undefined;
	} = $props();

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

	// Resolved by option id rather than a descendant class query: the old lookup
	// started at `document` and matched the first `#command-menu .cmd-menu` in the
	// page, which is the wrong list once two instances are mounted
	// (conduit-test-9kov). rAF still waits for the DOM update.
	function scrollActiveIntoView(): void {
		requestAnimationFrame(() => {
			document
				.getElementById(`${listboxId}-option-${activeIndex}`)
				?.scrollIntoView({ block: "nearest" });
		});
	}
</script>

<div id="command-menu" class:hidden={!isVisible}>
	{#if isVisible}
		<DetachedListbox
			id={listboxId}
			ariaLabel="Slash commands"
			radius="xl"
			class="cmd-menu absolute bottom-full left-0 right-0 mb-1 max-h-[300px] overflow-y-auto"
		>
			{#each filtered as cmd, i}
				<div
					class="cmd-item flex items-baseline gap-2 py-2 px-3.5 cursor-pointer transition-colors duration-100 max-sm:py-1.5 max-sm:px-2.5 max-sm:gap-1.5 {i === activeIndex ? 'bg-accent-bg hover:bg-accent-bg' : 'hover:bg-bg-alt'}"
					id="{listboxId}-option-{i}"
					data-cmd-index={i}
					role="option"
					aria-selected={i === activeIndex}
					tabindex="-1"
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
		</DetachedListbox>
	{/if}
</div>

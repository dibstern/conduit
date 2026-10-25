<!-- Command autocomplete popup for `/skill` and `$builtin`. Filters by prefix match, supports -->
<!-- keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse selection. -->
<!-- Preserves #command-menu wrapper ID for E2E compatibility. -->

<script lang="ts">
	import type { CommandInfo } from "../../types.js";
	import { filterCommands } from "../../stores/discovery.svelte.js";
	import DetachedListbox from "../ui/DetachedListbox.svelte";
	import CommandOption from "../ui/CommandOption.svelte";

	let {
		listboxId,
		query,
		visible,
		commands,
		trigger = "/",
		onSelect,
		onClose,
		activeIndex = $bindable(0),
		contextPercent = 0,
	}: {
		listboxId: string;
		query: string;
		visible: boolean;
		commands: CommandInfo[];
		trigger?: "/" | "$";
		onSelect: (command: string) => void;
		onClose: () => void;
		activeIndex?: number | undefined;
		contextPercent?: number;
	} = $props();

	const filtered = $derived(
		[...filterCommands(commands, query)].sort((a, b) =>
			(trigger === "$" ? Number(b.name === "goal") - Number(a.name === "goal") : 0) || a.name.localeCompare(b.name),
		),
	);

	const isVisible = $derived(visible && filtered.length > 0);
	const icons: Record<string, string> = { goal: "target", btw: "messages-square", clear: "refresh-cw", compact: "gauge", cost: "zap", help: "book-open", init: "file-code", memory: "brain", model: "sparkles" };

	$effect(() => {
		// Depend on filtered.length to reset on filter change
		void filtered.length;
		activeIndex = 0;
	});

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

	function selectCommand(cmd: CommandInfo): void {
		onSelect(`${trigger}${cmd.name} `);
	}

	// Resolved by option id rather than a descendant class query: the old lookup
	// started at `document` and matched the first `#command-menu .cmd-menu` in the
	// page, which is the wrong list once two instances are mounted
	//. rAF still waits for the DOM update.
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
			appearance="final"
			id={listboxId}
			ariaLabel={trigger === "$" ? "Built-in commands" : "Slash commands"}
			class="cmd-menu absolute bottom-full left-0 mb-1 w-[340px] max-w-full max-h-[360px] overflow-y-auto"
		>
			{#each filtered as cmd, i}
				<CommandOption
					active={i === activeIndex}
					goal={trigger === "$" && cmd.name === "goal"}
					icon={icons[cmd.name] ?? "terminal"}
					id="{listboxId}-option-{i}"
					data-cmd-index={i}
					onmousedown={(e) => {
						e.preventDefault();
						selectCommand(cmd);
					}}
					onmouseenter={() => {
						activeIndex = i;
					}}
				>
					<div class="min-w-0 flex-1">
						<span class="cmd-name block truncate text-[13.5px] text-text">{trigger}{cmd.name}{#if cmd.args}<span class="cmd-args ml-[6px] font-normal text-text-muted"> {cmd.args}</span>{/if}</span>
						{#if cmd.description}<span class="cmd-desc block truncate text-[12px] text-text-dimmer">{cmd.description}</span>{/if}
					</div>
					{#if trigger === "$" && cmd.name === "compact"}<span data-testid="command-context-percent" class="shrink-0 font-mono text-[11.5px] text-text-dimmer">{Math.round(contextPercent)}%</span>{/if}
				</CommandOption>
			{/each}
		</DetachedListbox>
	{/if}
</div>

<!-- ─── Context Window Picker ─────────────────────────────────────────────── -->
<!-- Claude context-window badge + dropdown. -->

<script lang="ts">
	import type { ContextWindowOption } from "../../types.js";
	import Icon from "../shared/Icon.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import {
		discoveryState,
		getActiveContextWindowOptions,
	} from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { switchContextWindowRpc } from "../../transport/ws-rpc-client.js";

	let { onOpen }: { onOpen?: () => void } = $props();

	let dropdownOpen = $state(false);

	const options = $derived(getActiveContextWindowOptions());
	const selectedValue = $derived(
		discoveryState.currentContextWindow || getDefaultValue(options),
	);
	const selectedOption = $derived(
		options.find((option) => option.value === selectedValue) ??
			options.find((option) => option.isDefault) ??
			options[0],
	);
	const currentLabel = $derived(selectedOption?.label ?? "default");
	const currentOverride = $derived(discoveryState.currentContextWindow);

	function getDefaultValue(
		contextOptions: ReadonlyArray<ContextWindowOption>,
	): string {
		return (
			contextOptions.find((option) => option.isDefault)?.value ??
			contextOptions[0]?.value ??
			""
		);
	}

	function toggleDropdown(e: MouseEvent) {
		e.stopPropagation();
		onOpen?.();
		dropdownOpen = !dropdownOpen;
	}

	function selectContextWindow(
		option: ContextWindowOption,
		e: MouseEvent,
	) {
		e.stopPropagation();
		const previousContextWindow = discoveryState.currentContextWindow;
		discoveryState.currentContextWindow = option.value;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchContextWindowRpc({
				projectSlug,
				sessionId,
				contextWindow: option.value,
			})
				.then((response) => {
					discoveryState.currentContextWindow = response.contextWindow;
					discoveryState.availableContextWindowOptions = response.options;
				})
				.catch(() => {
					discoveryState.currentContextWindow = previousContextWindow;
				});
		}
		dropdownOpen = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && dropdownOpen) {
			dropdownOpen = false;
		}
	}

	$effect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("keydown", handleKeydown);
		};
	});

	export function close() {
		dropdownOpen = false;
	}
</script>

{#if options.length > 0}
	<div class="relative" use:clickOutside={() => { dropdownOpen = false; }}>
		<button
			data-testid="context-window-badge"
			class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border border-border bg-bg-alt text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 hover:bg-bg hover:text-text-secondary font-brand"
			title="Context window ({currentLabel})"
			onclick={toggleDropdown}
		>
			{currentLabel}
			<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
		</button>

		{#if dropdownOpen}
			<div
				data-testid="context-window-dropdown"
				class="absolute bottom-[calc(100%+4px)] right-0 w-44 bg-bg-alt border border-border rounded-lg shadow-[0_-4px_16px_rgba(var(--shadow-rgb),0.3)] z-[210] py-1 font-brand"
			>
				<button
					data-testid="context-window-option-default"
					class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentOverride === '' ? 'text-accent' : ''}"
					onclick={(e) => selectContextWindow({ value: "", label: "default" }, e)}
				>
					{#if currentOverride === ""}
						<span class="text-accent font-bold text-xs">&#10003;</span>
					{:else}
						<span class="w-[10px]"></span>
					{/if}
					default
				</button>

				{#each options as option (option.value)}
					<button
						data-testid="context-window-option-{option.value}"
						class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentOverride === option.value ? 'text-accent' : ''}"
						onclick={(e) => selectContextWindow(option, e)}
					>
						{#if currentOverride === option.value}
							<span class="text-accent font-bold text-xs">&#10003;</span>
						{:else}
							<span class="w-[10px]"></span>
						{/if}
						{option.label}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

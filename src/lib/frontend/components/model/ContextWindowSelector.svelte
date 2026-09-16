<!-- ─── Context Window Picker ─────────────────────────────────────────────── -->
<!-- Claude context-window badge + dropdown. -->

<script lang="ts">
	import type { ContextWindowOption } from "../../types.js";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import {
		discoveryState,
		getActiveContextWindowOptions,
	} from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { switchContextWindowRpc } from "../../transport/ws-rpc-client.js";

	let { onOpen }: { onOpen?: (() => void) | undefined } = $props();
	const contextWindowState: {
		availableContextWindowOptions: Awaited<
			ReturnType<typeof switchContextWindowRpc>
		>["options"];
	} = discoveryState;

	let open = $state(false);

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

	function selectContextWindow(value: string) {
		const previousContextWindow = discoveryState.currentContextWindow;
		discoveryState.currentContextWindow = value;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchContextWindowRpc({
				projectSlug,
				sessionId,
				contextWindow: value,
			})
				.then((response) => {
					discoveryState.currentContextWindow = response.contextWindow;
					contextWindowState.availableContextWindowOptions = response.options;
				})
				.catch(() => {
					discoveryState.currentContextWindow = previousContextWindow;
				});
		}
	}

	export function close() {
		open = false;
	}
</script>

{#if options.length > 0}
	<Menu
		bind:open
		onopenchange={(nextOpen) => { if (nextOpen) onOpen?.(); }}
		side="top"
		align="end"
		data-testid="context-window-dropdown"
	>
		{#snippet trigger({ props })}
			<button
				{...props}
				data-testid="context-window-badge"
				class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border border-border bg-bg-alt text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 hover:bg-bg hover:text-text-secondary font-brand"
				title="Context window ({currentLabel})"
			>
				{currentLabel}
				<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
			</button>
		{/snippet}

		<MenuRadioGroup value={currentOverride}>
			<MenuRadioItem
				value=""
				data-testid="context-window-option-default"
				onselect={() => selectContextWindow("")}
			>
				default
			</MenuRadioItem>
			{#each options as option (option.value)}
				<MenuRadioItem
					value={option.value}
					data-testid="context-window-option-{option.value}"
					onselect={() => selectContextWindow(option.value)}
				>
					{option.label}
				</MenuRadioItem>
			{/each}
		</MenuRadioGroup>
	</Menu>
{/if}

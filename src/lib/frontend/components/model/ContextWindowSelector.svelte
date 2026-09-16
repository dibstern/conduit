<!-- ─── Context Window Picker ─────────────────────────────────────────────── -->
<!-- Claude context-window badge + dropdown. -->

<script lang="ts">
	import type { ContextWindowOption } from "../../types.js";
	import Button from "../ui/Button.svelte";
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
			<Button
				{...props}
				variant="pill"
				size="content"
				class="ml-0.5"
				data-testid="context-window-badge"
				title="Context window ({currentLabel})"
			>
				{currentLabel}
				<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
			</Button>
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

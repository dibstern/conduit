<script lang="ts">
	import { isThemeMode, setThemeMode, themeState, type ThemeMode } from "../../stores/theme.svelte.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";

	let { compact = false }: { compact?: boolean } = $props();
	const modes: { value: ThemeMode; label: string; icon: string }[] = [
		{ value: "light", label: "Light", icon: "sun" },
		{ value: "dark", label: "Dark", icon: "moon" },
		{ value: "system", label: "System", icon: "monitor" },
	];
</script>

<Menu ariaLabel="Theme" align="end">
	{#snippet trigger({ props })}
		<!-- Shows the theme on screen, not the mode: under System the check in the menu says so. -->
		<Button
			{...props}
			variant="toolbar"
			size="content"
			iconOnly
			icon={themeState.resolved === "light" ? "sun" : "moon"}
			iconSize={compact ? 18 : 16}
			class="shrink-0 rounded-[8px] {compact ? 'size-[44px]' : 'size-[28px]'}"
			title="Theme"
			ariaLabel="Theme"
			data-testid="list-bar-theme"
		/>
	{/snippet}
	<MenuRadioGroup value={themeState.mode} onvaluechange={(value) => { if (isThemeMode(value)) setThemeMode(value); }}>
		{#each modes as mode (mode.value)}
			<MenuRadioItem value={mode.value} icon={mode.icon} class={compact ? "min-h-[44px] md:min-h-0" : undefined} data-testid={`theme-option-${mode.value}`}>
				{mode.label}
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>

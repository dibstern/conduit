<!-- Attach button with a camera/photos dropdown.                             -->
<!--                                                                         -->
<!-- What this replaced: a Surface toggled by a     -->
<!-- `hidden` class, positioned by hand, with no role="menu", no              -->
<!-- role="menuitem", no roving focus, no arrow keys, no typeahead, no        -->
<!-- Escape-to-close and no focus return -- plus a trigger that declared      -->
<!-- neither aria-haspopup nor aria-expanded despite controlling the menu.    -->
<!-- ui/Menu supplies every one of those, so the open state, the outside-     -->
<!-- click listener and the `#attach-wrap` selector it keyed off are gone     -->
<!-- from InputArea as well.                                                  -->

<script lang="ts">
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	// `open` stays a bindable prop even though ui/Menu would happily own it
	// outright: it is the only handle a story has on the open state, and the
	// captured frame of an open menu is the whole visual coverage this component
	// has.
	let {
		open = $bindable(false),
		onCamera,
		onPhotos,
		onFiles,
		onSetGoal,
	}: {
		open?: boolean;
		onCamera: () => void;
		onPhotos: () => void;
		onFiles: () => void;
		onSetGoal: () => void;
	} = $props();
	const canSetGoal = $derived(discoveryState.currentTraits?.supportsGoalState);
</script>

<Menu
	bind:open
	ariaLabel="Attach"
	side="top"
	align="start"
	sideOffset={8}
	appearance="final"
	class="w-[340px] max-w-[calc(100vw-24px)]"
	data-testid="attach-menu"
>
	{#snippet trigger({ props })}
		<Button
			{...props}
			variant="ghost"
			size="composer-icon"
			tone="secondary"
			hoverFill="surface"
			iconOnly
			icon="plus"
			iconSize={16}
			touchTarget
			id="attach-btn"
			type="button"
			ariaLabel="Attach"
		/>
	{/snippet}

	<MenuItem id="attach-camera" density="touch" onselect={onCamera}>
		<Icon name="camera" size={16} class="shrink-0 text-text-dimmer" />
		<span>Take Photo</span>
	</MenuItem>

	<MenuItem id="attach-photos" density="touch" onselect={onPhotos}>
		<Icon name="image" size={16} class="shrink-0 text-text-dimmer" />
		<span>Add Photos</span>
	</MenuItem>

	<MenuItem id="attach-files" density="touch" onselect={onFiles}>
		<Icon name="file" size={16} class="shrink-0 text-text-dimmer" />
		<span>Add Files</span>
	</MenuItem>

	<MenuSeparator />
	<MenuItem
		data-testid="attach-set-goal"
		density="touch"
		disabled={!canSetGoal}
		onselect={onSetGoal}
	>
		<Icon name="target" size={16} class="shrink-0 text-status-goal" />
		<span class="flex flex-col">
			<span>{canSetGoal ? "Set goal" : "Goal"}</span>
			<span class="text-[12px] text-text-dimmer">{canSetGoal ? "Same as $goal" : "Claude only"}</span>
		</span>
	</MenuItem>
</Menu>

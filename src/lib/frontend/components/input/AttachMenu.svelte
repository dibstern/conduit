<!-- ─── Attach Menu ─────────────────────────────────────────────────────────── -->
<!-- Attach button with a camera/photos dropdown.                             -->
<!--                                                                         -->
<!-- What this replaced (conduit-test-de3.35.9.3): a Surface toggled by a     -->
<!-- `hidden` class, positioned by hand, with no role="menu", no              -->
<!-- role="menuitem", no roving focus, no arrow keys, no typeahead, no        -->
<!-- Escape-to-close and no focus return -- plus a trigger that declared      -->
<!-- neither aria-haspopup nor aria-expanded despite controlling the menu.    -->
<!-- ui/Menu supplies every one of those, so the open state, the outside-     -->
<!-- click listener and the `#attach-wrap` selector it keyed off are gone     -->
<!-- from InputArea as well.                                                  -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";

	// `open` stays a bindable prop even though ui/Menu would happily own it
	// outright: it is the only handle a story has on the open state, and the
	// captured frame of an open menu is the whole visual coverage this component
	// has.
	let {
		open = $bindable(false),
		onCamera,
		onPhotos,
	}: {
		open?: boolean;
		onCamera: () => void;
		onPhotos: () => void;
	} = $props();
</script>

<!-- `side="top"`: the composer sits at the bottom of the viewport, so the menu
     opened upwards as-found. `sideOffset` restates the old
     `bottom-[calc(100%+8px)]` gap rather than taking the 4px default.

     `font-brand` was on each row as-found and is the composer's typeface --
     the pills beside this button wear it too -- so it moves to the surface
     rather than being repeated per row. This is the only menu in the app that
     is not in the body font. -->
<Menu
	bind:open
	ariaLabel="Attach"
	side="top"
	align="start"
	sideOffset={8}
	class="min-w-[170px] font-brand"
	data-testid="attach-menu"
>
	{#snippet trigger({ props })}
		<Button
			{...props}
			variant="secondary"
			size="content"
			tone="muted"
			hoverFill="surface"
			iconOnly
			icon="plus"
			iconSize={18}
			id="attach-btn"
			type="button"
			ariaLabel="Attach"
			class="shrink-0 w-7 h-7 rounded-md bg-bg-alt"
		/>
	{/snippet}

	<MenuItem id="attach-camera" density="touch" onselect={onCamera}>
		<Icon name="camera" size={18} class="shrink-0" />
		<span>Take Photo</span>
	</MenuItem>

	<MenuItem id="attach-photos" density="touch" onselect={onPhotos}>
		<Icon name="image" size={18} class="shrink-0" />
		<span>Add Photos</span>
	</MenuItem>
</Menu>

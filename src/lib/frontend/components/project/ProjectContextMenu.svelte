<!-- ─── ProjectContextMenu ──────────────────────────────────────────────────── -->
<!-- Project actions: Rename, Remove.                                        -->
<!--                                                                         -->
<!-- Anchored to the "..." button its consumer already owns, the same shape   -->
<!-- SessionContextMenu settled on: the consumer mounts this only while the   -->
<!-- menu should be open, so `open` starts true and `onclose` unmounts us,    -->
<!-- and the empty trigger snippet is safe because by the time bits-ui would  -->
<!-- return focus to a trigger this component no longer exists.               -->
<!--                                                                         -->
<!-- What this replaced (conduit-test-de3.35.9.3): a fixed full-screen        -->
<!-- backdrop for outside clicks, manual getBoundingClientRect positioning    -->
<!-- with no collision handling, a window-level Escape listener, and two      -->
<!-- <button>s with no role="menu", no role="menuitem", no roving focus, no   -->
<!-- arrow keys, no typeahead and no focus return.                            -->

<script lang="ts">
	import type { ProjectInfo } from "../../types.js";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		project,
		anchor,
		onrename,
		ondelete,
		onclose,
	}: {
		project: ProjectInfo;
		anchor: HTMLElement;
		onrename?: ((slug: string) => void) | undefined;
		ondelete: (slug: string, title: string) => void;
		onclose: () => void;
	} = $props();

	let open = $state(true);
</script>

<Menu
	bind:open
	onopenchange={(nextOpen) => {
		if (!nextOpen) onclose();
	}}
	customAnchor={anchor}
	ariaLabel="Project actions"
	side="bottom"
	align="end"
	class="min-w-[160px]"
	data-testid="project-ctx-menu"
>
	<!-- Intentionally empty: the anchor is an element the consumer owns, so
	     there is nothing for us to render. `customAnchor` does the pointing. -->
	{#snippet trigger()}{/snippet}

	{#if onrename}
		<MenuItem
			data-testid="project-ctx-rename"
			onselect={() => onrename?.(project.slug)}
		>
			<Icon name="pencil" size={13} />
			<span>Rename</span>
		</MenuItem>
	{/if}

	<MenuItem
		variant="danger"
		data-testid="project-ctx-delete"
		onselect={() => ondelete(project.slug, project.title)}
	>
		<span>Remove</span>
	</MenuItem>
</Menu>

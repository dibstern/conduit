<script lang="ts">
	import Menu from "../Menu.svelte";
	import MenuRadioGroup from "../MenuRadioGroup.svelte";
	import ViewCard from "../ViewCard.svelte";

	let { view = "chat", disabled = false, badge = 0 }: {
		view?: "chat" | "terminal" | "diff" | "files";
		disabled?: boolean;
		badge?: number;
	} = $props();
	let open = $state(true);
	let picked = $state("chat");
	const labels = { chat: "Chat", terminal: "Terminal", diff: "Diff", files: "Files" };
	const icons = { chat: "message-square", terminal: "terminal", diff: "code", files: "folder-tree" };
</script>

<output data-testid="picked-view" class="sr-only">{picked}</output>
<Menu bind:open presentation="sheet" ariaLabel="Views">
	{#snippet trigger({ props })}<button {...props} class="min-h-[44px] px-[16px]">Open views</button>{/snippet}
	<MenuRadioGroup value={picked} class="mx-[16px] mt-[8px] w-[80px]">
		<ViewCard value={view} preview={view} label={labels[view]} icon={icons[view]} {disabled} {badge} onselect={() => { picked = view; }} />
	</MenuRadioGroup>
</Menu>

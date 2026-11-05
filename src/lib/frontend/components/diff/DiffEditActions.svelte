<!-- Stage and Discard for an unstaged file or one hunk of it. Discard asks to confirm first. -->
<script lang="ts">
	import TextButton from "../ui/TextButton.svelte";

	const { hunk = false, edit }: { hunk?: boolean; edit: (action: "discard" | "stage") => Promise<void> } = $props();

	let confirming = $state(false);
	let editing = $state(false);
	const noun = $derived(hunk ? " hunk" : "");

	async function run(action: "discard" | "stage") {
		confirming = false;
		editing = true;
		try {
			await edit(action);
		} finally {
			editing = false;
		}
	}
</script>

<span class="flex shrink-0 items-center gap-2 text-xs" data-testid={hunk ? "session-diff-hunk-actions" : "session-diff-file-actions"}>
	{#if confirming}
		<TextButton onclick={() => (confirming = false)}>Cancel</TextButton>
		<span class="text-error"><TextButton tone="inherit" onclick={() => run("discard")}>Confirm discard</TextButton></span>
	{:else}
		<TextButton disabled={editing} onclick={() => run("stage")}>Stage{noun}</TextButton>
		<TextButton disabled={editing} onclick={() => (confirming = true)}>Discard{noun}</TextButton>
	{/if}
</span>

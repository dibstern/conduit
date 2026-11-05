<!-- "Branch i of n" on the user message where the conversation branched (82tn.51). Its menu lists
     each branch by its first message; picking one moves the Head to that branch's tip. A branch
     whose rows are gone is listed as unavailable and cannot be picked. -->
<script lang="ts">
	import { type HeadFork, switchBranch } from "../../stores/head-moves.svelte.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";

	let { fork, sessionId }: { fork: HeadFork; sessionId: string } = $props();

	const current = $derived(fork.branches.findIndex((branch) => branch.onHead) + 1);
</script>

<Menu ariaLabel="Branches">
	{#snippet trigger({ props })}
		<Button {...props} variant="ghost" hoverFill="none" size="content" touchTarget data-testid="branch-switcher" class="rounded-full">
			<Badge variant="chip" size="label" shape="pill">Branch {current} of {fork.branches.length}</Badge>
		</Button>
	{/snippet}
	{#each fork.branches as branch (branch.tip)}
		<MenuItem
			variant={branch.onHead ? "selected" : "default"}
			disabled={!branch.available}
			detail={branch.available ? undefined : "unavailable"}
			onselect={() => { if (!branch.onHead) void switchBranch(sessionId, branch.tip); }}
		>{branch.text}</MenuItem>
	{/each}
</Menu>

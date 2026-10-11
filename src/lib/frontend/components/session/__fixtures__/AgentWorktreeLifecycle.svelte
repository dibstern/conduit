<script lang="ts">
	import type { SessionGit } from "../../../../shared-types.js";
	import Button from "../../ui/Button.svelte";
	import GitIdentity from "../GitIdentity.svelte";

	let { directory, git, presentation }: { directory: string; git: SessionGit | undefined; presentation: "word" | "control" | "row" } = $props();
	let entered = $state(false);
	const worktreeGit: SessionGit = {
		branch: "worktree-header-agent",
		worktree: "header-agent",
		dirty: true,
		ahead: 1,
		behind: 0,
	};
</script>

<div class="flex max-w-[320px] flex-col items-start gap-3">
	<p role="status" data-testid="agent-worktree-status" class="text-xs text-text-muted">Composer checkout · Running turn</p>
	<GitIdentity {presentation} directory={entered ? `${directory}/.claude/worktrees/header-agent` : directory} git={entered ? worktreeGit : git} />
	<div class="flex gap-2">
		<Button variant="ghost" disabled={entered} onclick={() => { entered = true; }}>EnterWorktree</Button>
		<Button variant="ghost" disabled={!entered} onclick={() => { entered = false; }}>ExitWorktree</Button>
	</div>
</div>

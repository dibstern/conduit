<script lang="ts">
	import type { SessionGit } from "../../../shared-types.js";

	let { project, git }: { project: string; git: SessionGit | undefined } = $props();
</script>

{#if !git}
	<span
		data-testid="session-bar-identity"
		class="min-w-0 truncate text-sm font-medium leading-none text-text-muted"
	>{project}</span>
{:else}
	<!-- Truncation is strictly ordered: project first, then worktree, then branch.
	     Flex shrink is proportional, so the weights are orders of magnitude apart;
	     closer weights let the branch lose a fraction of a pixel, which is enough
	     to ellipse it. The 4ch floors keep a readable stub, so a separator never
	     leads the line. -->
	<span
		data-testid="session-bar-identity"
		class="flex min-w-0 max-w-full items-center overflow-hidden text-sm font-medium leading-none text-text-muted"
	>
		<span class="min-w-[4ch] shrink-[100000000] truncate" title={project}>{project}</span>
		{#if git.branch}
			<span class="shrink-0 px-[4px]" aria-hidden="true">·</span>
			<span class="min-w-0 shrink truncate" title={`Branch: ${git.branch}`}>{git.branch}</span>
		{/if}
		{#if git.worktree}
			<span class="shrink-0 px-[4px]" aria-hidden="true">·</span>
			<span class="min-w-[4ch] shrink-[10000] truncate" title={`Linked worktree: ${git.worktree}`}>{git.worktree}</span>
		{/if}
		{#if git.dirty}
			<span class="shrink-0 pl-[4px] text-warning" title="Uncommitted changes"><span aria-hidden="true">●</span><span class="sr-only">Uncommitted changes</span></span>
		{/if}
	</span>
{/if}

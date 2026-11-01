<script lang="ts">
	import Button from "../../ui/Button.svelte";
	import ComposerControlWithPicker from "../../model/__fixtures__/ComposerControlWithPicker.svelte";

	// The story owns the session write: components may not speak the transport's vocabulary.
	let { presentation, setWorktree }: {
		presentation: "word" | "control";
		// Optional so the fixture stays assignable to the GitIdentity story type.
		setWorktree?: (entered: boolean) => void;
	} = $props();
	let entered = $state(false);
	function setEntered(value: boolean) {
		setWorktree?.(value);
		entered = value;
	}
</script>

<div class="flex max-w-[320px] flex-col items-start gap-3">
	<p role="status" data-testid="agent-worktree-status" class="text-xs text-text-muted">Composer checkout · Running turn</p>
	<ComposerControlWithPicker {presentation} />
	<div class="flex gap-2">
		<Button variant="ghost" disabled={entered} onclick={() => setEntered(true)}>EnterWorktree</Button>
		<Button variant="ghost" disabled={!entered} onclick={() => setEntered(false)}>ExitWorktree</Button>
	</div>
</div>

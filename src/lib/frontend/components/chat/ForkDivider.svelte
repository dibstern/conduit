<!-- Fork Divider -->
<!-- Horizontal rule with centered label showing the fork origin. -->
<!-- Clicking the parent title navigates to the parent session. -->

<script lang="ts">
	import { wsSend } from "../../stores/ws.svelte.js";

	interface Props {
		parentTitle: string;
		parentId: string;
	}

	let { parentTitle, parentId }: Props = $props();

	function navigateToParent() {
		wsSend({ type: "switch_session", sessionId: parentId });
	}
</script>

<div class="fork-divider flex items-center gap-3 my-4 max-w-[760px] mx-auto px-5">
	<div class="flex-1 h-px bg-border"></div>
	<span class="text-[11px] text-text-dimmer font-mono whitespace-nowrap">
		Forked from
		<button
			type="button"
			class="text-text-muted hover:text-text-secondary underline decoration-dotted cursor-pointer bg-transparent border-none p-0 font-mono text-[11px] transition-colors"
			onclick={navigateToParent}
			title="Go to parent session"
		>
			{parentTitle}
		</button>
	</span>
	<div class="flex-1 h-px bg-border"></div>
</div>

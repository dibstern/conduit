<!-- Fork Divider -->
<!-- Horizontal rule with centered label showing the fork origin. -->
<!-- Clicking the Source title navigates to the Source session. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { switchToSession } from "../../stores/session.svelte.js";

	interface Props {
		sourceTitle: string;
		sourceId: string;
	}

	let { sourceTitle, sourceId }: Props = $props();

	function navigateToSource() {
		switchToSession(sourceId);
	}
</script>

<div class="fork-divider flex items-center gap-3 my-4 max-w-[760px] mx-auto px-5">
	<div class="flex-1 h-px bg-border"></div>
	<span class="text-[11px] text-text-dimmer font-mono whitespace-nowrap">
		Forked from
		<Button
			variant="ghost"
			size="content"
			layout="flow"
			tone="muted-soft"
			hoverFill="none"
			type="button"
			class="underline decoration-dotted p-0 font-mono text-[11px]"
			onclick={navigateToSource}
			title="Go to source session"
		>
			{sourceTitle}
		</Button>
	</span>
	<div class="flex-1 h-px bg-border"></div>
</div>

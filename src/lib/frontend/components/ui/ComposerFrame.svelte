<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	let { words = false, goal = "none", children, class: className = "", ...rest }: {
		words?: boolean;
		goal?: "solid" | "dashed" | "none";
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "children"> = $props();
</script>

<div {...rest} data-words={words} data-goal={goal} class="composer-frame {className}">
	{@render children()}
</div>

<style>
	.composer-frame {
		position: relative;
		container: composer / inline-size;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 12px 10px 10px 16px;
		border-radius: 22px;
		background: var(--color-bg-surface);
		box-shadow: var(--shadow-composer);
	}
	.composer-frame:focus-within { outline: 1px solid var(--color-border); }
	[data-words="true"] { padding: 6px 6px 6px 8px; }
	/* After the focus outline, so focusing never hides the goal. */
	.composer-frame[data-goal="solid"] { outline: 1px solid var(--color-status-goal); }
	.composer-frame[data-goal="dashed"] { outline: 1px dashed var(--color-status-goal); }
	.composer-frame :global(.composer-text-metrics) { font-size: 15px; line-height: 24px; padding: 2px 0 10px; }
	[data-words="true"] :global(.composer-text-metrics) { padding: 0 4px; }
	[data-words="true"] :global(#image-preview) { padding-inline: 8px; }
	@media (max-width: 767px) {
		.composer-frame[data-words="false"] { padding: 10px 8px 8px 14px; }
		[data-words="false"] :global(.composer-text-metrics) { padding-bottom: 8px; }
	}
	@container composer (max-width: 440px) {
		:global([data-testid="picker-selected-context"]) { display: none; }
	}
	/* The reset time drops to its clock before the model label is starved. */
	@container composer (max-width: 360px) {
		:global(#send [data-testid="composer-send-at-label"]) { display: none; }
	}
	@container composer (max-width: 340px) {
		/* Keep both goal Send and Stop available while editing a busy turn. */
		.composer-frame:has(:global(#stop)):has(:global(#send[data-goal="true"])) :global(.model-btn) {
			padding-inline: 1px;
			gap: 0;
		}
	}
</style>

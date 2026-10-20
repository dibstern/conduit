<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		active = true,
		class: className = "",
		bodyClass = "",
		maxHeight = "90dvh",
		menuBody = false,
		bottomPadding = 12,
		safeAreaMode = "add",
		children,
		footer,
		...rest
	}: {
		/** Let a responsive caller keep its desktop container unchanged. */
		active?: boolean;
		bodyClass?: string;
		maxHeight?: string;
		/** A menu's items all use roving tabindex, so its scroll body needs its own keyboard target. */
		menuBody?: boolean;
		bottomPadding?: number;
		safeAreaMode?: "add" | "max";
		children: Snippet;
		footer?: Snippet | undefined;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#if active}
	<div {...rest} data-sheet-chrome style:max-height={maxHeight} style:--sheet-bottom-padding={`${bottomPadding}px`} class:sheet-inset-max={safeAreaMode === "max"} class="sheet-chrome relative flex w-full flex-col overflow-hidden rounded-t-[22px] bg-bg-surface text-text shadow-modal {className}">
		<div aria-hidden="true" data-sheet-handle class="mx-auto mt-[8px] mb-[6px] h-[5px] w-[36px] shrink-0 rounded-full bg-border-chip"></div>
		<!-- A menu's items all use roving tabindex, so its scroll body takes focus for axe's
		     scrollable-region-focusable. Inside role="menu" a focusable child must be an allowed
		     menu child, hence role="group". Dialogs keep their first control as the focus target. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div data-sheet-body tabindex={menuBody ? 0 : undefined} role={menuBody ? "group" : undefined} class="sheet-body min-h-0 overflow-y-auto overscroll-contain focus-visible:outline-hidden {footer ? 'pb-[12px]' : ''} {bodyClass}" class:sheet-body-inset={!footer}>
			{@render children()}
		</div>
		{#if footer}
			<div data-sheet-footer class="sheet-footer shrink-0 border-t border-border-subtle">
				{@render footer()}
			</div>
		{/if}
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.sheet-body-inset,
	.sheet-footer {
		padding-bottom: calc(var(--sheet-bottom-padding) + var(--sheet-safe-area-bottom, env(safe-area-inset-bottom, 0px)));
	}
	.sheet-inset-max > .sheet-body-inset,
	.sheet-inset-max > .sheet-footer {
		padding-bottom: max(var(--sheet-bottom-padding), var(--sheet-safe-area-bottom, env(safe-area-inset-bottom, 0px)));
	}
	.sheet-footer {
		background-image: linear-gradient(transparent, color-mix(in srgb, var(--color-backdrop) 6%, transparent));
	}
</style>

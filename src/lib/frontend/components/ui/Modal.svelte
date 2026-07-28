<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import Button from "./Button.svelte";
	import { dismiss } from "./actions/use-dismiss.svelte.js";
	import { focusTrap } from "./actions/use-focus-trap.svelte.js";

	type ModalSize = "sm" | "md" | "lg";

	type ModalOwnProps = {
		/** Controlled visibility. Modal never mutates it — dismiss gestures call `onclose`. */
		open: boolean;
		/** Any dismiss gesture (Escape, backdrop click, close button). The parent decides what it means. */
		onclose: () => void;
		/** Supporting text under the title; auto-wired to aria-describedby. */
		description?: string;
		size?: ModalSize;
		/** Escape + backdrop-click dismissal. Default true. The close button is gated by `showClose`. */
		dismissible?: boolean;
		/** Corner close button. Default true. */
		showClose?: boolean;
		/** Extra classes on the dialog panel. */
		class?: string;
		children: Snippet;
		/** Action row, rendered right-aligned below the body. */
		footer?: Snippet;
	} & (
		// A dialog must have an accessible name: `title` renders the labelled <h2>;
		// headerless dialogs must pass `ariaLabel` instead (compile-enforced, per Button).
		| { title: string; ariaLabel?: never }
		| { title?: undefined; ariaLabel: string }
	);

	let {
		open,
		onclose,
		title,
		description,
		ariaLabel,
		size = "md",
		dismissible = true,
		showClose = true,
		class: className,
		children,
		footer,
	}: ModalOwnProps = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const descriptionId = `${uid}-description`;
	const resolvedTitle = $derived(title?.trim() ? title : undefined);

	const SIZE_CLASSES: Record<ModalSize, string> = {
		sm: "max-w-80",
		md: "max-w-md",
		lg: "max-w-2xl",
	};

	const panelClass = $derived(
		[
			"relative flex max-h-[85vh] w-[90%] flex-col gap-4 rounded-xl border border-border bg-bg-alt px-6 py-5 shadow-modal",
			SIZE_CLASSES[size],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

{#if open}
	<div
		class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-backdrop backdrop-blur-[2px]"
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={resolvedTitle ? titleId : undefined}
			aria-label={resolvedTitle ? undefined : ariaLabel}
			aria-describedby={description ? descriptionId : undefined}
			class={panelClass}
			use:focusTrap
			use:dismiss={{ onDismiss: onclose, enabled: dismissible }}
		>
			{#if resolvedTitle || description}
				<header class="flex flex-col gap-1 pr-8">
					{#if resolvedTitle}<h2 id={titleId} class="text-base font-semibold text-text">{resolvedTitle}</h2>{/if}
					{#if description}<p id={descriptionId} class="text-sm text-text-secondary">{description}</p>{/if}
				</header>
			{/if}
			<div class="min-h-0 overflow-y-auto">{@render children()}</div>
			{#if footer}
				<footer class="flex justify-end gap-2">{@render footer()}</footer>
			{/if}
			{#if showClose}
				<div class="absolute top-3 right-3">
					<Button variant="ghost" size="sm" iconOnly ariaLabel="Close" onclick={onclose}>
						<Icon name="x" size={16} />
					</Button>
				</div>
			{/if}
		</div>
	</div>
{/if}

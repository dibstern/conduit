<script lang="ts">
	import type { Snippet } from "svelte";
	import Dialog from "./Dialog.svelte";
	import Button from "./Button.svelte";

	type ModalSize = "sm" | "md" | "lg";

	type ModalOwnProps = {
		/** Controlled visibility. Modal never mutates it — dismiss gestures call `onclose`. */
		open: boolean;
		/** Any dismiss gesture (Escape, backdrop click, close button). The parent decides what it means. */
		onclose: () => void;
		/** Supporting text under the title; auto-wired to aria-describedby. */
		description?: string | undefined;
		size?: ModalSize | undefined;
		placement?: "center" | "sheet" | undefined;
		/** Drop the panel's side padding so list rows run edge to edge. */
		flush?: boolean | undefined;
		/** Focus target after dismissal. */
		returnFocus?: (() => HTMLElement | null) | undefined;
		/** Escape + backdrop-click dismissal. Default true. The close button is gated by `showClose`. */
		dismissible?: boolean | undefined;
		/** Corner close button. Default true. */
		showClose?: boolean | undefined;
		/** Extra classes on the dialog panel. */
		class?: string | undefined;
		children: Snippet;
		/** Action row, rendered right-aligned below the body. */
		footer?: Snippet | undefined;
	} & (
		// A dialog must have an accessible name: `title` renders the labelled <h2>;
		// headerless dialogs must pass `ariaLabel` instead (compile-enforced, per Button).
		| { title: string; ariaLabel?: undefined }
		| { title?: undefined; ariaLabel: string }
	);

	let {
		open,
		onclose,
		title,
		description,
		ariaLabel,
		size = "md",
		placement = "center",
		flush = false,
		returnFocus,
		dismissible = true,
		showClose = true,
		class: className,
		children,
		footer,
	}: ModalOwnProps = $props();

	const resolvedTitle = $derived(title?.trim() ? title : undefined);
	const titleId = $props.id();
	const descriptionId = `${titleId}-description`;
	const SIZE_CLASSES: Record<ModalSize, string> = {
		sm: "max-w-80",
		md: "max-w-md",
		lg: "max-w-2xl",
	};
	const panelClass = $derived(
		[
			placement === "sheet"
				? "relative flex max-h-[90vh] w-full flex-col gap-4 rounded-t-[18px] border-t border-border bg-bg-alt pb-[calc(12px+env(safe-area-inset-bottom))] shadow-modal"
				: "relative flex max-h-[85vh] w-[90vw] flex-col gap-4 rounded-xl border border-border bg-bg-alt py-5 shadow-modal",
			flush ? undefined : "px-6",
			placement === "center" ? SIZE_CLASSES[size] : undefined,
			className,
		]
			.filter(Boolean)
			.join(" "),
	);

</script>

<Dialog
	{open}
	{onclose}
	{placement}
	{dismissible}
	{returnFocus}
	initialFocus="first"
	labelledBy={resolvedTitle ? titleId : undefined}
	ariaLabel={resolvedTitle ? undefined : ariaLabel}
	describedBy={description ? descriptionId : undefined}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class={panelClass}
		data-testid={placement === "sheet" ? "modal-sheet-panel" : undefined}
	>
		{#if placement === "sheet"}
			<div class="mx-auto mt-2 -mb-2 h-1 w-[38px] shrink-0 rounded-full bg-border" aria-hidden="true"></div>
		{/if}
		{#if resolvedTitle || description}
			<header class="flex flex-col gap-1 pr-8">
				{#if resolvedTitle}
					<h2 id={titleId} class="text-base font-semibold text-text">{resolvedTitle}</h2>
				{/if}
				{#if description}
					<p id={descriptionId} class="text-sm text-text-secondary">{description}</p>
				{/if}
			</header>
		{/if}
		<div class="min-h-0 overflow-y-auto">{@render children()}</div>
		{#if footer}
			<footer class="flex justify-end gap-2">{@render footer()}</footer>
		{/if}
		{#if showClose}
			<div class="absolute top-3 right-3">
				<!-- `icon`, not a child <Icon>: Button suppresses children
				     entirely when `iconOnly` is set, so passing the glyph as a
				     child rendered an empty ghost button. The baselines captured
				     that absence (conduit-test-uv4b); Button's trap is conduit-test-arl1. -->
				<Button
					variant="ghost"
					size="sm"
					iconOnly
					icon="x"
					ariaLabel="Close"
					onclick={onclose}
				/>
			</div>
		{/if}
	</div>
</Dialog>

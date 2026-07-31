<script lang="ts">
	import { Dialog } from "bits-ui";
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import Button from "./Button.svelte";
	import {
		backgroundInert,
		exemptFromBackgroundInert,
	} from "./actions/use-background-inert.svelte.js";

	type ModalSize = "sm" | "md" | "lg";

	type ModalOwnProps = {
		/** Controlled visibility. Modal never mutates it — dismiss gestures call `onclose`. */
		open: boolean;
		/** Any dismiss gesture (Escape, backdrop click, close button). The parent decides what it means. */
		onclose: () => void;
		/** Supporting text under the title; auto-wired to aria-describedby. */
		description?: string | undefined;
		size?: ModalSize | undefined;
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
		dismissible = true,
		showClose = true,
		class: className,
		children,
		footer,
	}: ModalOwnProps = $props();

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

	function containFocusWithoutTabbables(event: KeyboardEvent) {
		if (event.key !== "Tab") return;
		const dialog = event.currentTarget as HTMLElement;
		const hasTabbableDescendant = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
			),
		).some(
			(element) =>
				element.offsetParent !== null || element.getClientRects().length > 0,
		);
		if (hasTabbableDescendant) return;

		// Bits' focus scope returns early for an empty tabbable list, which would
		// otherwise let Tab escape a supported showClose={false} read-only modal.
		event.preventDefault();
		dialog.focus();
	}
</script>

{#if open}
	<!-- Keep the inert boundary in the consumer tree; live portal content is explicitly exempted. -->
	<span hidden use:backgroundInert></span>
{/if}

<Dialog.Root
	bind:open={
		() => open,
		(value) => {
			if (!value) onclose();
		}
	}
>
	<Dialog.Portal>
		<Dialog.Overlay
			class="fixed inset-0 z-[var(--z-modal)] bg-backdrop backdrop-blur-[2px]"
		>
			{#snippet child({ props })}
				<div {...props} use:exemptFromBackgroundInert></div>
			{/snippet}
		</Dialog.Overlay>
		<Dialog.Content
			aria-label={resolvedTitle ? undefined : ariaLabel}
			onEscapeKeydown={(event) => {
				event.preventDefault();
				if (dismissible) onclose();
			}}
			onInteractOutside={(event) => {
				event.preventDefault();
				if (dismissible) onclose();
			}}
		>
			{#snippet child({ props })}
				<div class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
					<div
						{...props}
						class={panelClass}
						onkeydown={containFocusWithoutTabbables}
						use:exemptFromBackgroundInert
					>
						{#if resolvedTitle || description}
							<header class="flex flex-col gap-1 pr-8">
								{#if resolvedTitle}
									<Dialog.Title>
										{#snippet child({ props: titleProps })}
											<h2 {...titleProps} class="text-base font-semibold text-text">
												{resolvedTitle}
											</h2>
										{/snippet}
									</Dialog.Title>
								{/if}
								{#if description}
									<Dialog.Description>
										{#snippet child({ props: descriptionProps })}
											<p {...descriptionProps} class="text-sm text-text-secondary">
												{description}
											</p>
										{/snippet}
									</Dialog.Description>
								{/if}
							</header>
						{/if}
						<div class="min-h-0 overflow-y-auto">{@render children()}</div>
						{#if footer}
							<footer class="flex justify-end gap-2">{@render footer()}</footer>
						{/if}
						{#if showClose}
							<div class="absolute top-3 right-3">
								<Button
									variant="ghost"
									size="sm"
									iconOnly
									ariaLabel="Close"
									onclick={onclose}
								>
									<Icon name="x" size={16} />
								</Button>
							</div>
						{/if}
					</div>
				</div>
			{/snippet}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

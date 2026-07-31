<script lang="ts">
	import { Dialog } from "bits-ui";
	import { untrack } from "svelte";
	import Button from "../Button.svelte";
	import Modal from "../Modal.svelte";

	type DemoProps = {
		title?: string | undefined;
		ariaLabel?: string | undefined;
		description?: string | undefined;
		size?: "sm" | "md" | "lg" | undefined;
		dismissible?: boolean | undefined;
		showClose?: boolean | undefined;
		withFooter?: boolean | undefined;
		bodyHasAction?: boolean | undefined;
		withBitsClose?: boolean | undefined;
		initiallyOpen?: boolean | undefined;
		/** Overrides the default close-on-dismiss wiring (controlled-proof tests). */
		onclose?: (() => void) | undefined;
	};

	let {
		title: titleProp,
		ariaLabel,
		description,
		size,
		dismissible,
		showClose,
		withFooter = false,
		bodyHasAction = true,
		withBitsClose = false,
		initiallyOpen = false,
		onclose,
	}: DemoProps = $props();

	let open = $state(untrack(() => initiallyOpen));
	const title = $derived(titleProp ?? (ariaLabel ? undefined : "Modal title"));
	const resolvedTitle = $derived(title?.trim() ? title : undefined);
	const resolvedAriaLabel = $derived(ariaLabel ?? "Modal");
</script>

{#snippet body()}
	<p>Modal body content.</p>
	{#if bodyHasAction}
		<Button variant="secondary">First action</Button>
	{/if}
	{#if withBitsClose}
		<Dialog.Close>Close through Bits</Dialog.Close>
	{/if}
{/snippet}

{#snippet actions()}
	<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
	<Button onclick={() => (open = false)}>Confirm</Button>
{/snippet}

<Button variant="secondary" onclick={() => (open = true)}>Open modal</Button>
{#if resolvedTitle}
	<Modal
		{open}
		onclose={onclose ?? (() => (open = false))}
		title={resolvedTitle}
		{description}
		{size}
		{dismissible}
		{showClose}
		children={body}
		footer={withFooter ? actions : undefined}
	/>
{:else}
	<Modal
		{open}
		onclose={onclose ?? (() => (open = false))}
		ariaLabel={resolvedAriaLabel}
		{description}
		{size}
		{dismissible}
		{showClose}
		children={body}
		footer={withFooter ? actions : undefined}
	/>
{/if}

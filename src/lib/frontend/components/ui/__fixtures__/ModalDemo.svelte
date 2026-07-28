<script lang="ts">
	import { untrack } from "svelte";
	import Button from "../Button.svelte";
	import Modal from "../Modal.svelte";

	type DemoProps = {
		title?: string;
		ariaLabel?: string;
		description?: string;
		size?: "sm" | "md" | "lg";
		dismissible?: boolean;
		showClose?: boolean;
		withFooter?: boolean;
		initiallyOpen?: boolean;
		/** Overrides the default close-on-dismiss wiring (controlled-proof tests). */
		onclose?: () => void;
	};

	let {
		title: titleProp,
		ariaLabel,
		description,
		size,
		dismissible,
		showClose,
		withFooter = false,
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
	<Button variant="secondary">First action</Button>
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

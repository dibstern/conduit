<script lang="ts">
	import Button from "../Button.svelte";
	import Textarea from "../Textarea.svelte";
	import TwoRowComposerLayout from "../TwoRowComposerLayout.svelte";

	let {
		placeholder = $bindable("Ask Claude…"),
		value = $bindable(""),
		working = $bindable(false),
		width = $bindable(393),
		showControls = $bindable(true),
	}: {
		placeholder?: string | undefined;
		value?: string | undefined;
		working?: boolean | undefined;
		width?: number | undefined;
		showControls?: boolean | undefined;
	} = $props();

	const longDraft = "Also run the Linux baselines before you call it done. Then check the composer on a phone.";
	const longPlaceholder = "Ask anything. / to use skills, @ to mention files, including a very long path to a file.";
</script>

<div class="bg-input-bg border border-border rounded-[20px] p-1.5" style:width="{width}px">
	<TwoRowComposerLayout data-testid="two-row-composer">
		{#snippet leading()}
			<Button variant="ghost" size="content" iconOnly icon="plus" ariaLabel="Attach" class="w-8 h-8" />
		{/snippet}
		{#snippet field()}
			<div class="grid grid-cols-1" style:min-height="var(--composer-placeholder-height,28px)">
				<div aria-hidden="true" class="invisible col-start-1 row-start-1 whitespace-pre-wrap [overflow-wrap:break-word] px-2 py-1 text-sm leading-5">{value}{"\u200b"}</div>
				<Textarea
					aria-label="Message"
					chrome="bare"
					size="content"
					rows={1}
					{placeholder}
					bind:value
					class="col-start-1 row-start-1 w-full h-full resize-none px-2 py-1 text-sm leading-5 text-text"
				/>
			</div>
		{/snippet}
		{#snippet controls()}
			{#if showControls}
				<div class="flex">
					<Button variant="ghost" size="content" iconOnly icon="settings" ariaLabel="Model" class="w-8 h-8" />
					<Button variant="ghost" size="content" iconOnly icon="sliders-horizontal" ariaLabel="Effort" class="w-8 h-8" />
					<Button variant="ghost" size="content" iconOnly icon="shield" ariaLabel="Approvals" class="w-8 h-8" />
				</div>
			{/if}
		{/snippet}
		{#snippet send()}
			<Button variant="primary" size="content" iconOnly icon="arrow-up" ariaLabel="Send" disabled={!value} class="w-8 h-8" />
			{#if working}
				<Button variant="secondary" size="content" iconOnly icon="square" ariaLabel="Stop" class="w-8 h-8" />
			{/if}
		{/snippet}
	</TwoRowComposerLayout>
</div>

<div class="flex flex-wrap gap-2 mt-4">
	<Button onclick={() => value = longDraft}>Long draft</Button>
	<Button onclick={() => value = "Hi"}>Short draft</Button>
	<Button onclick={() => placeholder = longPlaceholder}>Long placeholder</Button>
	<Button onclick={() => placeholder = "Ask Claude…"}>Short placeholder</Button>
	<Button onclick={() => working = !working}>Toggle stop</Button>
	<Button onclick={() => showControls = !showControls}>Toggle controls</Button>
	<Button onclick={() => width = 180}>Narrow composer</Button>
	<Button onclick={() => width = 393}>Widen composer</Button>
</div>

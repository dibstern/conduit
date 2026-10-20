<!-- Non-image attachment: a 48px chip in the image thumbs' frame. The composer
     passes onremove for the same corner badge as ImageAttachmentThumb; the
     sent message omits it. -->
<script lang="ts">
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";

	let {
		name,
		detail,
		testid,
		onremove,
	}: {
		name: string;
		/** Second line: size, or type and size. */
		detail: string;
		testid: string;
		onremove?: (event: MouseEvent) => void;
	} = $props();
</script>

<div data-testid={testid} class="relative flex h-[48px] max-w-[220px] shrink-0 items-center gap-[8px] rounded-[10px] bg-bg-raised pl-[10px] {onremove ? 'pr-[14px]' : 'pr-[10px]'}">
	<Icon name="file" size={18} class="shrink-0 text-text-muted" />
	<span class="min-w-0">
		<span class="block truncate text-[12px] text-text" title={name}>{name}</span>
		<span class="block truncate text-[11px] text-text-muted">{detail}</span>
	</span>
	{#if onremove}
		<span class="absolute -right-[6px] -top-[6px]">
			<Button variant="inverse" size="content" iconOnly icon="x" iconSize={10} ariaLabel={`Remove file ${name}`} title="Remove file" class="size-[18px] rounded-full" touchTarget onclick={onremove} />
		</span>
	{/if}
</div>

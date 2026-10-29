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
		kind = "file",
		onremove,
	}: {
		name: string;
		/** Second line: size, or type and size. */
		detail: string;
		testid: string;
		/** A review comment from the diff wears a comment glyph and is removed as a comment. */
		kind?: "file" | "comment";
		onremove?: (event: MouseEvent) => void;
	} = $props();
</script>

<div data-testid={testid} class="relative flex h-[48px] max-w-[220px] shrink-0 items-center gap-[8px] rounded-[10px] bg-bg-raised pl-[10px] {onremove ? 'pr-[14px]' : 'pr-[10px]'}">
	<Icon name={kind === "file" ? "file" : "message-square"} size={18} class="shrink-0 text-text-muted" />
	<span class="min-w-0">
		<span class="block truncate text-[12px] text-text" title={name}>{name}</span>
		<span class="block truncate text-[11px] text-text-muted">{detail}</span>
	</span>
	{#if onremove}
		<span class="absolute -right-[6px] -top-[6px]">
			<Button variant="inverse" size="content" iconOnly icon="x" iconSize={10} ariaLabel={`Remove ${kind} ${name}`} title={`Remove ${kind}`} class="size-[18px] rounded-full" touchTarget onclick={onremove} />
		</span>
	{/if}
</div>

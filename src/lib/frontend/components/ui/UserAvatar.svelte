<script lang="ts">
	import type { Avatar } from "../../../contracts/user-avatar.js";
	import { avatarState } from "../../stores/avatar.svelte.js";
	import { face } from "../../utils/avatar-face.js";

	let { avatar, size = 28, class: className = "" }:
		{ avatar?: Avatar; size?: number; class?: string } = $props();
	const resolvedAvatar = $derived(avatar ?? avatarState.current);
	const drawing = $derived(face(resolvedAvatar));
</script>

<span aria-hidden="true" data-testid="user-avatar" data-kind={drawing.kind} data-seed={resolvedAvatar.choice?.kind === "shape" ? resolvedAvatar.choice.seed : undefined}
	class="user-avatar inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white {className}"
	style:width={`${size}px`} style:height={`${size}px`} style:font-size={`${size * (drawing.kind === 'preset' ? .52 : .44)}px`}
	style:background={"background" in drawing ? drawing.background : undefined}>
	{#if drawing.kind === "letter"}{drawing.char}
	{:else if drawing.kind === "image"}<img src={drawing.src} alt="" class="size-full object-cover" />
	{:else if drawing.kind === "preset"}{drawing.glyph}
	{:else}{@html drawing.svg}{/if}
</span>

<style>
	.user-avatar :global(svg) { display: block; width: 100%; height: 100%; }
</style>

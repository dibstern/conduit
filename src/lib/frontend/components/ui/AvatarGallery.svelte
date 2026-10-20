<script lang="ts">
	import type { Avatar, AvatarChoice } from "../../../contracts/user-avatar.js";
	import { AVATAR_PRESETS } from "../../utils/avatar-face.js";
	import UserAvatar from "./UserAvatar.svelte";
	import Radio from "./Radio.svelte";
	import Button from "./Button.svelte";
	import { untrack } from "svelte";

	let { avatar, choice = $bindable(), compact = false }:
		{ avatar: Avatar; choice: AvatarChoice; compact?: boolean } = $props();
	const uid = $props.id();
	let seeds = $state(untrack(() => Array.from({ length: 6 }, (_, i) => ((choice.kind === "shape" ? choice.seed : 0) + i) | 0)));
	const items = $derived(choice.kind === "preset"
		? AVATAR_PRESETS.map(({ id, label }) => ({ label, choice: { kind: "preset", id } satisfies AvatarChoice }))
		: seeds.map((seed) => ({ label: `Shape ${seed}`, choice: { kind: "shape", seed } satisfies AvatarChoice })));

	function selected(item: AvatarChoice): boolean {
		return item.kind === "preset" && choice.kind === "preset" ? item.id === choice.id
			: item.kind === "shape" && choice.kind === "shape" && item.seed === choice.seed;
	}
	function shuffle(): void {
		seeds = [...crypto.getRandomValues(new Int32Array(6))];
		choice = { kind: "shape", seed: seeds[0] ?? 0 };
	}
</script>

<div class={compact ? 'flex min-w-0 items-center gap-[6px]' : 'flex flex-col items-center'}>
	<fieldset aria-label={choice.kind === "preset" ? "Preset pictures" : "Generated shapes"}
		class="min-w-0 flex-1 {compact ? 'flex gap-[2px] overflow-x-auto overscroll-x-contain pb-[4px]' : 'grid w-full grid-cols-6 gap-x-[2px] gap-y-[8px]'}">
		{#each items as item (item.label)}
			<label class="relative grid size-[44px] shrink-0 cursor-pointer place-items-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-text">
				<Radio class="sr-only" name={uid} aria-label={item.label} checked={selected(item.choice)} onchange={() => choice = item.choice} />
				<UserAvatar avatar={{ ...avatar, choice: item.choice }} size={compact ? 32 : 40} class={selected(item.choice) ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-surface' : ''} />
			</label>
		{/each}
	</fieldset>
	{#if choice.kind === "shape"}
		<Button variant="secondary" size="content" touchTarget icon="refresh-cw" iconSize={14} ariaLabel="Shuffle" class={compact ? 'size-[34px] shrink-0 rounded-full' : 'mt-[16px] min-h-[30px] gap-[5px] rounded-full px-[12px] text-[13px]'} onclick={shuffle}>
			{#if !compact}Shuffle{/if}
		</Button>
	{/if}
</div>

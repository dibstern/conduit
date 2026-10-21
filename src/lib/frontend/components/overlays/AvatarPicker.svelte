<script lang="ts">
	import type { Snippet } from "svelte";
	import type { AvatarChoice } from "../../../contracts/user-avatar.js";
	import { avatarState, saveAvatar } from "../../stores/avatar.svelte.js";
	import { face } from "../../utils/avatar-face.js";
	import Popover from "../ui/Popover.svelte";
	import UserAvatar from "../ui/UserAvatar.svelte";
	import AvatarGallery from "../ui/AvatarGallery.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import Button from "../ui/Button.svelte";

	let { trigger }: { trigger: Snippet<[{ props: Record<string, unknown> }]> } = $props();
	let open = $state(false);
	let choice = $state<AvatarChoice>({ kind: "initial" });
	let kind = $state<AvatarChoice["kind"]>("initial");
	const preview = $derived({ ...avatarState.current, choice });
	const initial = $derived(face({ ...avatarState.current, choice: { kind: "initial" } }));
	const options = $derived([
		{ value: "initial", label: "Initial" },
		...(avatarState.current.macPicture ? [{ value: "mac", label: "Mac" }] : []),
		{ value: "preset", label: "Preset" }, { value: "shape", label: "Shape" },
	]);
	function changeOpen(next: boolean): void {
		open = next;
		if (!next) return;
		choice = avatarState.current.choice ?? { kind: "initial" };
		if (choice.kind === "mac" && !avatarState.current.macPicture) choice = { kind: "initial" };
		kind = choice.kind;
		avatarState.error = "";
	}
	$effect(() => {
		if (kind === choice.kind) return;
		choice = kind === "preset" ? { kind: "preset", id: "fox" }
			: kind === "shape" ? { kind: "shape", seed: 0 }
			: kind === "mac" ? { kind: "mac" } : { kind: "initial" };
	});
	async function done(): Promise<void> {
		if (await saveAvatar(choice)) open = false;
	}
</script>

<Popover bind:open onopenchange={changeOpen} presentation="auto" ariaLabel="Your avatar" align="end" class="w-[380px] max-w-[calc(100vw-24px)] p-[20px] max-md:w-full max-md:max-w-none" {trigger}>
	<div data-testid="avatar-picker">
		<div class="grid grid-cols-[1fr_auto_1fr] items-center text-[15px]">
			<h2 class="col-start-2 font-semibold">Your avatar</h2>
			<Button variant="ghost" tone="accent" hoverFill="none" size="content" touchTarget loading={avatarState.saving} class="col-start-3 min-h-[28px] justify-self-end font-semibold" onclick={done}>Done</Button>
		</div>
		<div data-testid="avatar-preview" class="my-[18px] flex flex-col items-center gap-[10px]">
			<UserAvatar avatar={preview} size={72} />
			<p class="text-[12.5px] text-text-muted">Next to your messages, on every device.</p>
		</div>
		<SegmentedControl bind:value={kind} {options} variant="avatar" label="Avatar kind" />
		<div class="mt-[18px]">
			{#if choice.kind === "preset" || choice.kind === "shape"}
				{#key choice.kind}<AvatarGallery avatar={avatarState.current} bind:choice />{/key}
			{:else if choice.kind === "mac"}
				<p class="text-center text-[13px] leading-[1.55] text-text-secondary">From your Mac account. Change it in<br />System Settings › Users &amp; Groups.</p>
			{:else}
				<p class="text-center text-[13px] leading-[1.55] text-text-secondary">“{initial.kind === "letter" ? initial.char : "?"}”, the first letter of your git or account name.<br />On the default blue-violet gradient.</p>
			{/if}
		</div>
		{#if avatarState.error}<p role="alert" class="mt-[12px] text-[13px] text-error">{avatarState.error}</p>{/if}
	</div>
</Popover>

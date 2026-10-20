<script lang="ts">
	import type { AvatarChoice } from "../../../contracts/user-avatar.js";
	import { avatarState, saveAvatar } from "../../stores/avatar.svelte.js";
	import { face } from "../../utils/avatar-face.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Dialog from "../ui/Dialog.svelte";
	import UserAvatar from "../ui/UserAvatar.svelte";
	import AvatarGallery from "../ui/AvatarGallery.svelte";
	import Radio from "../ui/Radio.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";

	let { open }: { open: boolean } = $props();
	let choice = $state<AvatarChoice>({ kind: "initial" });
	let shapeBatch = $state(0);
	const uid = $props.id();
	const presetSamples = ["fox", "orb-violet", "saturn", "orb-mint"] as const;
	const LONG = ["Add an unread count to each session row.", "Done. Each row now shows what you haven't seen."] as const;
	const SHORT = ["Add unread counts to rows.", "Done, each row has one now."] as const;
	const preview = $derived({ ...avatarState.current, choice });
	const initial = $derived(face({ ...avatarState.current, choice: { kind: "initial" } }));
	const options = $derived([
		{ label: "Initial", sub: `${initial.kind === "letter" ? initial.char : "?"}, from your git or account name`, choice: { kind: "initial" } as AvatarChoice },
		...(avatarState.current.macPicture ? [{ label: "Mac picture", sub: "Your Mac account picture", choice: { kind: "mac" } as AvatarChoice }] : []),
		{ label: "Preset", sub: "Pick one of 12", choice: { kind: "preset", id: "fox" } as AvatarChoice },
		{ label: "Shape", sub: "Generated for you", choice: { kind: "shape", seed: 0 } as AvatarChoice },
	]);
</script>

{#snippet chat(selected: AvatarChoice, [mine, theirs]: readonly [string, string])}
	<div class="rounded-[12px] bg-bg px-[12px] py-[12px] max-md:bg-bg-surface">
		<div class="mb-[12px] grid grid-cols-[28px_minmax(0,1fr)] gap-[8px]">
			<UserAvatar avatar={{ ...avatarState.current, choice: selected }} size={28} />
			<div><div class="mb-[2px] flex min-h-[28px] items-center gap-[8px] text-[13px]"><b class="font-semibold">You</b><span class="font-mono text-[11px] text-text-dimmer">10:14</span></div><p class="text-[13px] leading-[1.55]">{mine}</p></div>
		</div>
		<div class="grid grid-cols-[28px_minmax(0,1fr)] gap-[8px]">
			<span class="grid size-[28px] place-items-center rounded-[8px] bg-harness-claude text-white [&_g]:fill-current"><Icon name="claude" size={18} /></span>
			<div><div class="mb-[2px] flex min-h-[28px] flex-wrap items-center gap-[8px] text-[13px]"><b class="font-semibold">Claude</b><span class="font-mono text-[11px] text-text-dimmer">Sonnet 5</span></div><p class="text-[13px] leading-[1.55]">{theirs}</p></div>
		</div>
	</div>
{/snippet}

<Dialog {open} onclose={() => {}} dismissible={false} ariaLabel="How should you look in chats?" placement={sessionViewState.compact ? "fullscreen" : "center"}>
	<div data-testid="avatar-first-run" class="flex max-h-[90dvh] w-[1120px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-[18px] bg-bg px-[36px] py-[28px] ring-1 ring-border max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:rounded-none max-md:px-[16px] max-md:pb-[max(26px,env(safe-area-inset-bottom))] max-md:pt-[18px]">
		<h2 class="text-[22px] font-semibold tracking-[-.01em]">How should you look in chats?</h2>
		<p class="mb-[22px] mt-[6px] text-[14px] text-text-secondary"><span class="max-md:hidden">Your initial is already set. Pick something else if you like; Settings › General can change it later.</span><span class="md:hidden">You can change it later in Settings.</span></p>
		<div data-testid="avatar-preview" class="mb-[14px] md:hidden">{@render chat(choice, SHORT)}</div>
		<fieldset aria-label="Your avatar" style:grid-template-columns={sessionViewState.compact ? undefined : "repeat(auto-fit, minmax(min(210px, 100%), 1fr))"} class="grid gap-[14px] max-md:gap-0 max-md:overflow-hidden max-md:rounded-[14px] max-md:bg-bg-surface">
			{#each options as option (option.choice.kind)}
				<div class="min-w-0 rounded-[14px] bg-bg-surface p-[14px] ring-inset max-md:rounded-none max-md:border-b max-md:border-settings-separator max-md:p-0 max-md:last:border-b-0 {choice.kind === option.choice.kind ? 'md:ring-2 md:ring-accent' : 'md:ring-1 md:ring-border'}">
					<div class="flex items-center gap-[8px]">
					<label class="flex min-h-[28px] min-w-0 flex-1 cursor-pointer items-center gap-[8px] max-md:min-h-[56px] max-md:px-[14px]">
						<span class="md:hidden"><UserAvatar avatar={{ ...preview, choice: choice.kind === option.choice.kind ? choice : option.choice }} size={32} /></span>
						<Radio name={uid} aria-label={option.label} checked={choice.kind === option.choice.kind} onchange={() => choice = option.choice} class="max-md:order-last" />
						<span class="flex-1 text-[14px] max-md:text-[15px]"><b class="font-semibold max-md:font-normal">{option.label}</b><small class="block text-[12px] text-text-muted md:hidden">{option.sub}</small></span>
						{#if option.choice.kind === "initial"}<small class="text-[12px] text-text-muted max-md:hidden">git config</small>{:else if option.choice.kind === "mac"}<small class="text-[12px] text-text-muted max-md:hidden">This Mac</small>{/if}
						{#if option.choice.kind === "preset"}<span aria-hidden="true" class="flex gap-[4px] max-md:hidden">{#each presetSamples as id}<UserAvatar avatar={{ ...avatarState.current, choice: { kind: "preset", id } }} size={18} />{/each}</span>{/if}
					</label>
					{#if option.choice.kind === "shape"}<Button variant="secondary" size="content" icon="refresh-cw" iconSize={12} ariaLabel="Shuffle" class="min-h-[24px] gap-[4px] rounded-full px-[10px] text-[12px] max-md:hidden" onclick={() => { choice = { kind: "shape", seed: crypto.getRandomValues(new Int32Array(1))[0] ?? 0 }; shapeBatch++; }}>Shuffle</Button>{/if}
					</div>
					<div class="mt-[10px] max-md:hidden">{@render chat(choice.kind === option.choice.kind ? choice : option.choice, LONG)}</div>
					{#if choice.kind === option.choice.kind && (choice.kind === "preset" || choice.kind === "shape")}
						<div class="px-[10px] pb-[12px] md:hidden">{#key choice.kind}<AvatarGallery avatar={avatarState.current} bind:choice compact />{/key}</div>
					{/if}
				</div>
			{/each}
		</fieldset>
		{#if choice.kind === "preset" || choice.kind === "shape"}
			<div class="mt-[16px] w-[380px] max-w-full self-end max-md:hidden">{#key `${choice.kind}:${shapeBatch}`}<AvatarGallery avatar={avatarState.current} bind:choice />{/key}</div>
		{/if}
		{#if avatarState.error}<p role="alert" class="mt-[12px] text-[13px] text-error">{avatarState.error}</p>{/if}
		<div class="mt-[22px] flex items-center justify-between gap-[16px] max-md:mt-auto max-md:pt-[22px]">
			<p class="text-[13px] text-text-muted max-md:hidden">Saved on this computer's conduit, so every browser and phone shows the same one.</p>
			<Button variant="primary" size="content" loading={avatarState.saving} class="min-h-[36px] rounded-full px-[22px] text-[14px] font-semibold max-md:min-h-[48px] max-md:w-full max-md:rounded-[14px] max-md:text-[16px]" onclick={() => { void saveAvatar(choice); }}>Continue</Button>
		</div>
	</div>
</Dialog>

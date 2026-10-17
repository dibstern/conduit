<script lang="ts">
	import { avatarState } from "../../../stores/avatar.svelte.js";
	import type { AvatarStoryKind } from "../../../stories/avatar.js";
	import UserMessage from "../../chat/UserMessage.svelte";
	import AvatarSettings from "../../overlays/AvatarSettings.svelte";
	import AvatarFirstRun from "../../overlays/AvatarFirstRun.svelte";

	let { scene = "chat" }: { scene?: "chat" | "picker" | "first-run"; kind?: AvatarStoryKind } = $props();
</script>

<div class="min-h-dvh bg-bg pt-[32px] text-text">
	<UserMessage message={{ type: "user", uuid: "avatar-story", text: "Add an unread count to each session row.", createdAt: 1_800_000_000_000 }} />
	<div class="mx-auto max-w-[720px] px-[16px]"><AvatarSettings /></div>
	{#if scene === "first-run"}<AvatarFirstRun open={avatarState.current.choice === null} />{/if}
</div>

<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import UserAvatar from "../ui/UserAvatar.svelte";
	import Button from "../ui/Button.svelte";
	import AvatarPicker from "./AvatarPicker.svelte";
	import Icon from "../ui/Icon.svelte";
	let { root = false }: { root?: boolean } = $props();
</script>

{#if root}
	<div class="mb-[18px]">
		<SettingsGroup>
			<AvatarPicker>
				{#snippet trigger({ props })}
					<Button {...props} variant="ghost" hoverFill="none" size="content" align="start" class="min-h-[56px] w-full gap-[12px] px-[14px] py-[8px]" data-testid="avatar-change-root">
						<UserAvatar size={40} />
						<span class="min-w-0 flex-1 text-left"><span class="block text-[15px] text-text">You</span><span class="mt-px block text-[12px] leading-[1.4] text-text-dimmer">Avatar, on every device</span></span>
						<Icon name="chevron-right" size={14} class="text-settings-icon" />
					</Button>
				{/snippet}
			</AvatarPicker>
		</SettingsGroup>
	</div>
{:else}
<SettingsGroup id="settings-you" title="You">
	<div class="flex min-h-[46px] items-center gap-[12px] px-[14px] py-[8px] max-md:min-h-[48px]">
		<UserAvatar size={32} />
		<div class="min-w-0 flex-1"><p class="text-[13.5px] text-text max-md:text-[15px]">Your avatar</p><p class="mt-px text-[12px] leading-[1.4] text-text-dimmer">Next to your messages, on every device</p></div>
		<AvatarPicker>
			{#snippet trigger({ props })}<Button {...props} variant="settings" size="content" touchTarget data-testid="avatar-change">Change…</Button>{/snippet}
		</AvatarPicker>
	</div>
</SettingsGroup>
{/if}

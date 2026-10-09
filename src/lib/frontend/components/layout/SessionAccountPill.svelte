<!--
  SessionAccountPill — which Claude account the open session runs on, and the
  control to move it to another (design frame D). It stands where the instance
  badge does for OpenCode sessions, but a pick here moves only this session
  through the usage-limit strip's own picker, confirm and ContinueSession; the
  project's binding is never touched.

  The account follows the session's latest resume, so a switch shows here the
  moment the session row says so. Renders nothing without a second Claude
  account to go to.
-->
<script lang="ts">
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import type { Immutable, SessionInfo } from "../../types.js";
	import AccountSwitch from "../input/AccountSwitch.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Button from "../ui/Button.svelte";

	let { session }: { session: Immutable<SessionInfo> } = $props();

	const account = $derived(getInstanceById(session.resumes?.at(-1)?.instanceId ?? discoveryState.sessionInstanceIds[session.id] ?? ""));
	const canSwitch = $derived(instanceState.instances.some((instance) => instance.driver === "claude" && instance.id !== account?.id));
	// An open limit on this account carries its cut-off request into the handoff.
	const limit = $derived.by(() => {
		const recovery = session.limitRecovery;
		return recovery && !recovery.switched && !recovery.continued && recovery.instanceId === account?.id ? recovery : undefined;
	});
	const projectSlug = $derived(getCurrentSlug());
	// Shrinks beside a long branch, keeping 4 letters plus the ellipsis (5ch): dot, gap, padding and border on top, 1px of rounding slack.
	const minimumWidth = $derived(`calc(${Math.min(account?.name.length ?? 0, 5)}ch + 6px + 5px + ${sessionViewState.compact ? 12 : 16}px + 2px + 1px)`);
</script>

{#if account?.driver === "claude" && canSwitch && projectSlug}
	<AccountSwitch sessionId={session.id} {projectSlug} account={account.id} {limit} side="bottom">
		{#snippet trigger({ props, loading })}
			<Button
				{...props}
				variant="ghost"
				size="content"
				hoverFill="base"
				iconSize={10}
				touchTarget
				{loading}
				ariaLabel={`Session account: ${account.name}`}
				title="Switch this session's account"
				data-testid="session-account-pill"
				data-account={account.id}
				style={`min-width: ${minimumWidth}`}
				class="gap-[5px] rounded-full border border-border bg-bg-alt font-mono {sessionViewState.compact ? 'h-[20px] px-[6px] text-[9px]' : 'h-[22px] px-[8px] text-[10px]'}"
			>
				<AccountDot instanceId={account.id} size={6} />
				<span class="min-w-0 max-w-[140px] truncate">{account.name}</span>
			</Button>
		{/snippet}
	</AccountSwitch>
{/if}

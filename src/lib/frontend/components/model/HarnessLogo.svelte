<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { composerAccountId } from "../../stores/usage.svelte.js";
	import { accountColorClass } from "../../utils/account-color.js";

	let { driver, instanceId, size, surface }: {
		driver: "claude" | "opencode";
		instanceId: string;
		// 15 and 17 retire with bn6x.8/.9.
		size: 12 | 13 | 15 | 16 | 17;
		surface: "box" | "surface" | "page";
	} = $props();

	const session = $derived(findSession(sessionState.currentId ?? ""));
	const projectSlug = $derived(
		session ? session.projectSlug ?? getCurrentSlug() ?? "" : getDraftProject() ?? getCurrentSlug() ?? "",
	);
	const accounts = $derived(getClaudeAccounts(projectSlug));
	const instances = $derived(getAvailableInstances());
	const badged = $derived(
		driver === "claude" ? accounts.accounts.length >= 2 : instances.filter((instance) => instance.driver === driver).length >= 2,
	);
	const letter = $derived(accounts.nameOf(
		instanceId,
		driver === "claude" ? "Claude" : instances.find((instance) => instance.id === instanceId)?.label ?? "OpenCode",
	).charAt(0).toUpperCase());
	const spinning = $derived(
		driver === "claude" && accounts.switchingTo !== null &&
		accounts.handoff.kind !== "idle" && accounts.handoff.sessionId === sessionState.currentId &&
		(instanceId === accounts.switchingTo || instanceId === (composerAccountId(session, undefined) ?? "claude")),
	);
</script>

<span
	aria-hidden="true"
	data-testid="harness-logo"
	data-driver={driver}
	data-account={instanceId}
	data-surface={surface}
	class="logo"
	class:badged
	style="--s:{size}px"
>
	<Icon name={driver} {size} />
	{#if badged}
		<span
			data-testid="harness-logo-badge"
			data-account={instanceId}
			data-state={spinning ? "spinning" : "idle"}
			class="badge font-mono {accountColorClass(instanceId)}"
		>{spinning ? "" : letter}</span>
	{/if}
</span>

<style>
	.logo {
		--ring: var(--color-bg);
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: var(--s);
		height: var(--s);
	}
	.logo[data-surface="box"] { --ring: var(--color-input-bg); }
	.logo[data-surface="surface"] { --ring: var(--color-bg-surface); }
	.logo.badged { margin-right: calc(var(--s) * .4); }
	.badge {
		position: absolute;
		right: calc(var(--s) * -.42);
		bottom: calc(var(--s) * -.38);
		width: calc(var(--s) * .74);
		height: calc(var(--s) * .74);
		padding: 0 1px;
		border-radius: 999px;
		color: #111;
		text-align: center;
		font-size: calc(var(--s) * .5);
		font-weight: 700;
		line-height: calc(var(--s) * .74);
		box-shadow: 0 0 0 1.5px var(--ring);
	}
	.badge[data-state="spinning"] {
		background: var(--color-bg-alt);
		border: 1.5px solid var(--color-text-muted);
		border-top-color: transparent;
		animation: spin .8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>

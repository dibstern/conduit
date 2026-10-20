<script lang="ts">
	import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
	import Icon from "../ui/Icon.svelte";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { composerAccountId } from "../../stores/usage.svelte.js";
	import { accountColorClass } from "../../utils/account-color.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";

	let { driver, instanceId, size, surface }: {
		driver: ProviderDriverKind;
		instanceId: string | undefined;
		/** The tile's edge; the mark inside is 60% of it, as in the Final design. */
		size: 15 | 18;
		surface: "box" | "surface" | "page";
	} = $props();

	const session = $derived(findSession(sessionState.currentId ?? ""));
	const projectSlug = $derived(
		session ? session.projectSlug : getDraftProject() ?? "",
	);
	const accounts = $derived(getClaudeAccounts(projectSlug));
	const instances = $derived(getAvailableInstances());
	const traits = $derived(getDriverTraits(driver));
	const presentation = $derived(getProviderPresentation(driver));
	const badged = $derived(
		instanceId !== undefined && (traits?.usageHarness === "claude" ? accounts.accounts.length >= 2 : instances.filter((instance) => instance.driver === driver).length >= 2),
	);
	const letter = $derived(accounts.nameOf(
		instanceId,
		traits?.accountKind === "config-directory" ? presentation?.label ?? driver : instances.find((instance) => instance.id === instanceId)?.label ?? driver,
	).charAt(0).toUpperCase());
	const spinning = $derived(
		traits?.usageHarness === "claude" && accounts.switchingTo !== null &&
		accounts.handoff.kind !== "idle" && accounts.handoff.sessionId === sessionState.currentId &&
		(instanceId === accounts.switchingTo || instanceId === composerAccountId(session)),
	);
</script>

<span
	aria-hidden="true"
	data-testid="harness-logo"
	data-driver={driver}
	data-account={instanceId}
	data-surface={surface}
	class="logo {driver === 'claude' ? 'bg-harness-claude text-white [&_g]:fill-current' : 'bg-chip'}"
	class:badged
	style="--s:{size}px"
>
	{#if presentation}
		<Icon name={presentation.logo} size={Math.round(size * .6)} />
	{:else}
		<Icon name="bot" size={Math.round(size * .6)} class="text-text-secondary" />
	{/if}
	{#if badged && instanceId !== undefined}
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
		border-radius: calc(var(--s) * .28);
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

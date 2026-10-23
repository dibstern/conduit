<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
	import Icon from "../ui/Icon.svelte";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { accountColorClass } from "../../utils/account-color.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";

	let { driver, instanceId, size, aligned = false, spinning = false, "data-testid": testId = "harness-logo", class: className = "", ...rest }: HTMLAttributes<HTMLSpanElement> & {
		driver: ProviderDriverKind;
		instanceId?: string | undefined;
		/** The tile's edge; the mark inside is 60% of it, as in the Final design. */
		size: 15 | 18;
		aligned?: boolean | undefined;
		spinning?: boolean | undefined;
		"data-testid"?: string;
	} = $props();

	const presentation = $derived(getProviderPresentation(driver));
	const badged = $derived(
		instanceId !== undefined && instanceState.instances.filter((instance) => (instance.driver ?? "opencode") === driver).length >= 2,
	);
	const letter = $derived((getInstanceById(instanceId ?? "")?.name || presentation?.label || driver).charAt(0).toUpperCase());
</script>

<span
	{...rest}
	aria-hidden="true"
	data-testid={testId}
	data-driver={driver}
	data-account={instanceId}
	class="logo {className}"
	class:badged
	class:aligned
	style="--s:{size}px"
>
	<span class="tile {driver === 'claude' ? 'bg-harness-claude text-white [&_g]:fill-current' : 'bg-chip'}">
		{#if presentation}
			<Icon name={presentation.logo} size={Math.round(size * .6)} />
		{:else}
			<Icon name="bot" size={Math.round(size * .6)} class="text-text-secondary" />
		{/if}
	</span>
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
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		width: var(--s);
		height: var(--s);
	}
	.tile {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: calc(var(--s) * .28);
	}
	.logo.badged, .logo.aligned { margin-right: calc(var(--s) * .4); }
	.logo.badged .tile {
		mask: radial-gradient(circle at 105% 101%, transparent calc(var(--s) * .37 + 1.5px), #000 calc(var(--s) * .37 + 2px));
	}
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
	}
	.badge[data-state="spinning"] {
		background: var(--color-bg-alt);
		border: 1.5px solid var(--color-text-muted);
		border-top-color: transparent;
		animation: spin .8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>

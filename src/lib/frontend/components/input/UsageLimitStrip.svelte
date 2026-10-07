<!-- The limit strip above the composer while a session's account is at its usage
     limit. A pure render of the session row's `limitRecovery` plus its recovery
     actions: no close button, it leaves when the server nulls the field. The
     actions sit at the right of the row, on a wrapped second row on phones. -->
<script lang="ts">
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { continueSessionRpc } from "../../transport/ws-rpc-client.js";
	import { formatSnoozeTime } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";

	let {
		limitRecovery,
		sessionId,
		projectSlug,
	}: { limitRecovery: LimitRecovery; sessionId: string; projectSlug: string } = $props();

	let retrying = $state(false);

	const account = $derived(
		getInstanceById(limitRecovery.instanceId)?.name ?? limitRecovery.instanceId,
	);
	const limitWindow = $derived(
		limitRecovery.rateLimitType.startsWith("seven_day")
			? "Weekly limit"
			: limitRecovery.rateLimitType === "five_hour"
				? "5-hour limit"
				: "Usage limit",
	);
	const detail = $derived.by(() => {
		if (limitRecovery.resetsAt === undefined)
			return sessionViewState.compact ? `${account} · reset time unavailable` : "Reset time unavailable";
		const resets = `resets ${formatSnoozeTime(limitRecovery.resetsAt * 1000)}`;
		return `${sessionViewState.compact ? account : limitWindow} · ${resets}`;
	});

	// Same account, run now: the server re-checks quota before it continues. A
	// refusal leaves the strip as it is; success hides the button until the
	// reply clears the strip.
	async function tryAgain(): Promise<void> {
		retrying = true;
		try {
			await continueSessionRpc({
				projectSlug,
				sessionId,
				instanceId: limitRecovery.instanceId,
				expectedInstanceId: limitRecovery.instanceId,
				originId: getBrowserClientId(),
			});
		} catch (error) {
			showToast(error instanceof Error && error.message ? error.message : "Couldn't continue the session", { variant: "error" });
		} finally {
			retrying = false;
		}
	}
</script>

<Surface
	variant="danger"
	radius="none"
	data-testid="usage-limit-strip"
	class="mb-2 flex flex-wrap items-center gap-[7px] rounded-2xl px-[10px] py-[7px] text-[11.5px] leading-[1.35]"
>
	<Icon name="gauge" size={13} class="shrink-0 text-error" />
	<span class="min-w-0 flex-1">
		<b data-testid="usage-limit-title" class="font-semibold text-text">Usage limit reached{sessionViewState.compact ? "" : ` · ${account}`}</b><br />
		<span data-testid="usage-limit-detail" class="text-text-dimmer">{detail}</span>
	</span>
	{#if limitRecovery.resetsAt === undefined && !limitRecovery.continued}
		<Button
			variant="inverse"
			size="content"
			iconSize={12}
			loading={retrying}
			disabled={retrying}
			data-testid="usage-limit-try-again"
			class="shrink-0 px-[10px] font-semibold {sessionViewState.compact ? 'mt-[6px] h-[34px] w-full rounded-[10px] text-[12px]' : 'h-[24px] rounded-[8px] text-[11px]'}"
			onclick={tryAgain}
		>Try again</Button>
	{/if}
</Surface>

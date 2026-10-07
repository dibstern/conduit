<!-- The limit strip above the composer while a session's account is at its usage
     limit. A pure render of the session row's `limitRecovery`: no close button,
     it leaves when the server nulls the field. The right of the row (a wrapped
     second row on phones) is kept free for the recovery actions that follow. -->
<script lang="ts">
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { formatSnoozeTime } from "../../utils/format.js";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";

	let { limitRecovery }: { limitRecovery: LimitRecovery } = $props();

	const account = $derived(
		getInstanceById(limitRecovery.instanceId)?.name ?? limitRecovery.instanceId,
	);
	const resets = $derived(
		limitRecovery.resetsAt === undefined
			? ""
			: ` · resets ${formatSnoozeTime(limitRecovery.resetsAt * 1000)}`,
	);
	const limitWindow = $derived(
		limitRecovery.rateLimitType.startsWith("seven_day")
			? "Weekly limit"
			: limitRecovery.rateLimitType === "five_hour"
				? "5-hour limit"
				: "Usage limit",
	);
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
		<span data-testid="usage-limit-detail" class="text-text-dimmer">{sessionViewState.compact ? account : limitWindow}{resets}</span>
	</span>
</Surface>

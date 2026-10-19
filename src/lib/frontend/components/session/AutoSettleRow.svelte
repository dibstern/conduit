<script lang="ts">
	import { untrack } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import { describeAutoSettle } from "../../utils/auto-settle.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import SwitchRow from "../ui/SwitchRow.svelte";
	import { sessionCommandActions } from "./session-commands.js";

	let { session, now, testId = "session-ctx-auto-settle" }: { session: SessionInfo; now: number; testId?: string } = $props();
	let outlook = $state<Awaited<ReturnType<typeof rpc<"GetSessionAutoSettleOutlook">>>>();
	let saving = $state(false);
	let request = 0;
	const sessionId = $derived(session.id);
	const checked = $derived(outlook ? outlook.kind !== "off" : session.autoSettleDisabled !== true);
	$effect(() => {
		// Unrelated shell updates must not invalidate an in-flight save.
		const id = sessionId;
		const read = ++request;
		outlook = undefined;
		saving = false;
		void untrack(() => rpc("GetSessionAutoSettleOutlook", { sessionId: id })).then(
			(reply) => { if (read === request) outlook = reply; },
			() => {},
		);
		return () => { ++request; };
	});
	async function toggle() {
		if (saving) return;
		const write = ++request;
		saving = true;
		const reply = await sessionCommandActions.autoSettle(session, checked);
		if (write !== request) return;
		if (reply) outlook = reply;
		saving = false;
	}
</script>

<SwitchRow data-testid={testId} aria-label="Auto-settle when idle" label="Auto-settle" {checked} {saving} controlled showState={outlook !== undefined} description={outlook && describeAutoSettle(outlook, now)} oncheckedchange={() => void toggle()} />

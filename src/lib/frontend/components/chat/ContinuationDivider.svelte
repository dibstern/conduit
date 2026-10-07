<!--
  ContinuationDivider — the transcript's record that the session moved to
  another Claude account: "↪ Continued on personal · switched by you", and a
  What carried over? link that reopens the handoff summary read-only. On phones
  the link drops to its own centred line so the caption doesn't truncate it.
-->
<script lang="ts">
	import type { HandoffSummary, SessionResume } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getContinuationHandoffRpc } from "../../transport/ws-rpc-client.js";
	import HandoffDialog from "../overlays/HandoffDialog.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TranscriptDivider from "../ui/TranscriptDivider.svelte";

	let { resume, sessionId, projectSlug }: { resume: SessionResume; sessionId: string; projectSlug: string } = $props();

	// undefined until asked for; null when nothing has been handed over yet.
	let handoff = $state<HandoffSummary | null | undefined>();

	async function showHandoff(): Promise<void> {
		try {
			const response = await getContinuationHandoffRpc({
				projectSlug,
				sessionId,
				instanceId: resume.instanceId,
				at: resume.at,
				originId: getBrowserClientId(),
			});
			handoff = response.handoff;
		} catch {
			showToast("Couldn't load what carried over", { variant: "error" });
		}
	}
</script>

{#snippet link()}
	<TextButton tone="secondary" underline="always" data-testid="transcript-divider-handoff" onclick={() => void showHandoff()}>What carried over?</TextButton>
{/snippet}

<TranscriptDivider data-testid="transcript-divider" data-switch="true" class="max-w-[760px] mx-auto px-5">
	↪ Continued on <AccountDot instanceId={resume.instanceId} size={6} class="mx-[1px] align-middle" /> <b>{getInstanceById(resume.instanceId)?.name ?? resume.instanceId}</b> · {resume.reason === "auto-switch" ? "auto-switch" : "switched by you"}{#if !sessionViewState.compact}&nbsp;· {@render link()}{/if}
</TranscriptDivider>
{#if sessionViewState.compact}
	<div class="-mt-[10px] mb-[12px] flex justify-center font-mono text-[10.5px]">{@render link()}</div>
{/if}

{#if handoff !== undefined}
	<HandoffDialog open onclose={() => (handoff = undefined)} to={resume.instanceId} summary={handoff} />
{/if}

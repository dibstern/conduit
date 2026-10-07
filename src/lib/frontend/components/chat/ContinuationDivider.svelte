<!--
  ContinuationDivider — the transcript's record that the session moved to
  another Claude account: "↪ Continued on personal · switched by you", and a
  What carried over? link that reopens the handoff summary read-only. On phones
  the link drops to its own centred line so the caption doesn't truncate it.
-->
<script lang="ts">
	import type { SessionResume } from "../../../contracts/limit-recovery.js";
	import { reviewHandoff } from "../../stores/handoff-review.svelte.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TranscriptDivider from "../ui/TranscriptDivider.svelte";

	let { resume, sessionId, projectSlug }: { resume: SessionResume; sessionId: string; projectSlug: string } = $props();
</script>

{#snippet link()}
	<TextButton tone="secondary" underline="always" data-testid="transcript-divider-handoff" onclick={() => void reviewHandoff(projectSlug, sessionId, resume)}>What carried over?</TextButton>
{/snippet}

<TranscriptDivider data-testid="transcript-divider" data-switch="true" class="max-w-[760px] mx-auto px-5">
	↪ Continued on <AccountDot instanceId={resume.instanceId} size={6} class="mx-[1px] align-middle" /> <b>{getInstanceById(resume.instanceId)?.name ?? resume.instanceId}</b> · {resume.reason === "auto-switch" ? "auto-switch" : "switched by you"}{#if !sessionViewState.compact}&nbsp;· {@render link()}{/if}
</TranscriptDivider>
{#if sessionViewState.compact}
	<div class="-mt-[10px] mb-[12px] flex justify-center font-mono text-[10.5px]">{@render link()}</div>
{/if}

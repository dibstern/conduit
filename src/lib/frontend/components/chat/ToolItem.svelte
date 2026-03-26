<!-- ─── Tool Item ───────────────────────────────────────────────────────────── -->
<!-- Thin dispatcher that routes tool messages to the appropriate sub-component. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";

	import ToolQuestionCard from "./ToolQuestionCard.svelte";
	import ToolSubagentCard from "./ToolSubagentCard.svelte";
	import ToolGenericCard from "./ToolGenericCard.svelte";

	let { message, isFirstInGroup = true, isLastInGroup = true }: {
		message: ToolMessage;
		isFirstInGroup?: boolean;
		isLastInGroup?: boolean;
	} = $props();

	const isQuestion = $derived(message.name === "AskUserQuestion");
	const isSubagent = $derived(message.name === "Task" || message.name === "task");

	const groupRadius = $derived.by(() => {
		if (isFirstInGroup && isLastInGroup) return "rounded-[10px]";
		if (isFirstInGroup) return "rounded-t-[10px]";
		if (isLastInGroup) return "rounded-b-[10px]";
		return "";
	});

	// Compute isDeferredQuestion directly to avoid a circular dependency:
	// ToolQuestionCard can only mount inside the {:else} branch, so we can't
	// rely on bind:this to read its isDeferredQuestion value.
	// Simplified: deferred = question tool is active AND has a real (non-synthetic)
	// pending question in the permissions store.
	const isDeferredQuestion = $derived.by(() => {
		if (!isQuestion) return false;
		if (message.status !== "pending" && message.status !== "running") return false;
		// Check if there's a matching pending question (non-synthetic = has a real que_ ID)
		return permissionsState.pendingQuestions.some(
			(q) => q.toolUseId === message.id || q.toolId === message.id
		);
	});
</script>

<!-- Active non-synthetic questions are deferred to the bottom of MessageList.
	 Hide the entire tool-item wrapper to avoid empty margin/padding. -->
{#if isDeferredQuestion}
	<!-- Rendered at bottom of MessageList instead -->
{:else}
<div
	class="tool-item max-w-[760px] mx-auto px-5"
	class:mt-1.5={isFirstInGroup}
	class:mt-0.5={!isFirstInGroup}
	class:mb-0.5={!isLastInGroup}
	class:mb-1={isLastInGroup}
	data-tool-id={message.id}
	data-tool-status={message.status}
>
{#if isQuestion}
	<ToolQuestionCard {message} {groupRadius} />
{:else if isSubagent}
	<ToolSubagentCard {message} {groupRadius} />
{:else}
	<ToolGenericCard {message} {groupRadius} />
{/if}
</div>
{/if}

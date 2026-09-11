<!-- ─── Tool Item ───────────────────────────────────────────────────────────── -->
<!-- Thin dispatcher that routes tool messages to the appropriate sub-component. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { isSubagentToolName } from "../../utils/subagent-tools.js";

	import ToolQuestionCard from "./ToolQuestionCard.svelte";
	import ToolSubagentCard from "./ToolSubagentCard.svelte";
	import ToolGenericCard from "./ToolGenericCard.svelte";

	let { message }: { message: ToolMessage } = $props();

	const isQuestion = $derived(message.name === "AskUserQuestion");
	const isSubagent = $derived(isSubagentToolName(message.name));

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
<!-- The transcript's width and gutter belong to whatever renders this; the card
	 only owns its own margin. -->
<div class="tool-item my-1" data-tool-id={message.id} data-tool-status={message.status}>
{#if isQuestion}
	<ToolQuestionCard {message} />
{:else if isSubagent}
	<ToolSubagentCard {message} />
{:else}
	<ToolGenericCard {message} />
{/if}
</div>
{/if}

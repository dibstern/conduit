<!-- ─── Tool Item ───────────────────────────────────────────────────────────── -->
<!-- Thin dispatcher that routes tool messages to the appropriate sub-component. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { isSubagentToolName } from "../../utils/subagent-tools.js";

	import ToolQuestionCard from "./ToolQuestionCard.svelte";
	import ToolSubagentCard from "./ToolSubagentCard.svelte";
	import ToolGenericCard from "./ToolGenericCard.svelte";

	let { message }: { message: ToolMessage } = $props();

	const isQuestion = $derived(message.name === "AskUserQuestion");
	const isSubagent = $derived(isSubagentToolName(message.name));
</script>

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

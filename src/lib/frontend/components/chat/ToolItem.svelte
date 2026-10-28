<!-- Thin dispatcher that routes tool messages to the appropriate sub-component. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { isSubagentToolName } from "../../utils/subagent-tools.js";

	import ToolQuestionCard from "./ToolQuestionCard.svelte";
	import ToolSubagentCard from "./ToolSubagentCard.svelte";
	import ToolGenericCard from "./ToolGenericCard.svelte";
	import Button from "../ui/Button.svelte";
	import { firstLine } from "../../utils/turns.js";

	let { message, presentation = "card" }: { message: ToolMessage; presentation?: "card" | "log" } = $props();
	let expanded = $state(false);

	const isQuestion = $derived(message.name === "AskUserQuestion");
	const isSubagent = $derived(isSubagentToolName(message.name));
</script>

<!-- The transcript's width and gutter belong to whatever renders this; the card
	 only owns its own margin. -->
<div class="tool-item my-[3px] min-w-0" data-tool-id={message.id} data-tool-status={message.status}>
{#if isQuestion}
	<ToolQuestionCard {message} {presentation} />
{:else if presentation === "log"}
	<Button variant="ghost" size="transcript" layout="flow" tone="inherit" hoverFill="surface" aria-expanded={expanded} data-testid="turn-hand-back-row" onclick={() => expanded = !expanded}>
		<span class="text-text-muted">?</span><span class="truncate text-text-secondary">Plan approval → {firstLine(message.result ?? "No answer")}</span>
	</Button>
	{#if expanded}<ToolGenericCard {message} />{/if}
{:else if isSubagent}
	<ToolSubagentCard {message} />
{:else}
	<ToolGenericCard {message} />
{/if}
</div>

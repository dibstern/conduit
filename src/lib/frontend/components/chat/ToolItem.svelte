<!-- ─── Tool Item ───────────────────────────────────────────────────────────── -->
<!-- Displays a tool invocation with status dot, name, result, and expand. -->
<!-- For task/subagent tools, renders a special agent card with session navigation. -->
<!-- Preserves .tool-item class and data-tool-id for E2E. -->

<script lang="ts">
	import type { ToolMessage, QuestionRequest, AskUserQuestion } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { extractToolSummary } from "../../utils/group-tools.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";

	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';
	import QuestionCard from "./QuestionCard.svelte";

	let { message, isFirstInGroup = true, isLastInGroup = true }: { 
		message: ToolMessage; 
		isFirstInGroup?: boolean; 
		isLastInGroup?: boolean;
	} = $props();
	let expanded = $state(false);
	let loadingFullContent = $state(false);

	function formatKB(length: number): string {
		return `${(length / 1024).toFixed(1)} KB`;
	}

	let loadingTimeout: ReturnType<typeof setTimeout> | undefined;

	function requestFullContent() {
		loadingFullContent = true;
		wsSend({ type: "get_tool_content", toolId: message.id });
		clearTimeout(loadingTimeout);
		loadingTimeout = setTimeout(() => {
			loadingFullContent = false;
		}, TOOL_CONTENT_LOAD_TIMEOUT_MS);
	}

	$effect(() => {
		if (!message.isTruncated) {
			loadingFullContent = false;
			clearTimeout(loadingTimeout);
		}
	});

	// ─── Question detection ─────────────────────────────────────────────────
	// The question tool name is "AskUserQuestion" (mapped from "question").
	// When the question is active, render the interactive QuestionCard inline.
	// When completed/historical, show a read-only summary.

	const isQuestion = $derived(message.name === "AskUserQuestion");

	/**
	 * Parse question data from the tool input.
	 * Used for rendering (both interactive and read-only) when no pending
	 * question match exists in the permissions store.
	 */
	const questionDataFromInput = $derived.by((): AskUserQuestion[] | null => {
		if (!isQuestion) return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		const rawQuestions = inp['questions'] as Array<{
			question?: string;
			header?: string;
			options?: Array<{ label?: string; description?: string }>;
			multiple?: boolean;
			multiSelect?: boolean;
			custom?: boolean;
		}> | undefined;
		if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

		return rawQuestions.map((q) => ({
			question: q.question ?? "",
			header: q.header ?? "",
			options: (q.options ?? []).map((o) => ({
				label: o.label ?? "",
				description: o.description ?? "",
			})),
			// Tool input uses `multiple`; AskUserQuestion uses `multiSelect`
			multiSelect: q.multiSelect ?? q.multiple ?? false,
			custom: q.custom ?? true,
		}));
	});

	/**
	 * Match this tool message to a pending question from the permissions store.
	 * Returns the QuestionRequest if the question is genuinely pending (has a
	 * server-side que_ ID), or null if no match.
	 */
	const pendingQuestionRequest = $derived.by((): QuestionRequest | null => {
		if (!isQuestion) return null;

		// Primary: match by toolUseId (toolu_ callID) — reliable 1:1 correlation
		const byToolUseId = permissionsState.pendingQuestions.find(
			(q) => q.toolUseId === message.id
		);
		if (byToolUseId) return byToolUseId;

		// Secondary: exact toolId match (for edge cases where toolId = message.id)
		const byToolId = permissionsState.pendingQuestions.find(
			(q) => q.toolId === message.id
		);
		if (byToolId) return byToolId;

		// Tertiary: content-match against pending questions to find the correct que_ ID
		const fallbackQuestions = questionDataFromInput;
		if (fallbackQuestions) {
			const contentMatch = permissionsState.pendingQuestions.find((pq) => {
				if (pq.questions.length !== fallbackQuestions.length) return false;
				return pq.questions.every((pqQ, i) => {
					const q = fallbackQuestions[i];
					return q && pqQ.question === q.question && pqQ.header === q.header;
				});
			});
			if (contentMatch) return contentMatch;
		}

		return null;
	});

	/** Whether the question is actively pending and should show an interactive card.
	 *  True when EITHER:
	 *  1. The tool is running AND matched to a pendingQuestion (has server-side que_ ID), OR
	 *  2. The tool is running AND we have question data from the tool input (cross-process
	 *     case where GET /question returns empty, but the tool is still running). */
	const isQuestionActive = $derived(
		isQuestion &&
		(message.status === "pending" || message.status === "running") &&
		(pendingQuestionRequest !== null || questionDataFromInput !== null)
	);

	/**
	 * The question request used for the interactive QuestionCard.
	 * Prefers the pending question request (has genuine que_ ID for reply).
	 * Falls back to a synthetic QuestionRequest built from tool input data
	 * (uses the tool's message.id as toolId — the handler will try to
	 * resolve it via the API fallback).
	 */
	const questionRequest = $derived.by((): QuestionRequest | null => {
		if (pendingQuestionRequest) return pendingQuestionRequest;
		if (!questionDataFromInput) return null;
		return {
			toolId: message.id,
			toolUseId: message.id,
			questions: questionDataFromInput,
		};
	});

	/** True when the question was reconstructed from tool input data rather
	 *  than received via a live ask_user event. This indicates the question
	 *  likely originated in a different process (e.g. terminal/TUI) and the
	 *  answer may not be deliverable. */
	const isSyntheticQuestion = $derived(
		isQuestionActive && pendingQuestionRequest === null
	);

	/** Whether this active question is deferred to the bottom of MessageList
	 *  (i.e. not synthetic and has a pending question in the permissions store). */
	const isDeferredQuestion = $derived(
		isQuestionActive && questionRequest !== null && !isSyntheticQuestion
	);

	/** Extract question data for read-only display.
	 *  Prefers the pending question request (accurate), falls back to tool input. */
	const questionData = $derived.by(() => {
		if (!isQuestion) return null;
		return pendingQuestionRequest?.questions ?? questionDataFromInput;
	});

	/** Parse the answer from the tool result text */
	const questionAnswer = $derived.by((): string | null => {
		if (!isQuestion || !message.result) return null;
		return message.result;
	});

	// ─── Subagent detection ─────────────────────────────────────────────────
	// The task tool name is "Task" (mapped) or "task" (raw). Input contains
	// description, subagent_type, prompt, and optionally task_id.
	// The result contains "task_id: <session_id>" on the first line.

	const isSubagent = $derived(
		message.name === "Task" || message.name === "task"
	);

	const taskInput = $derived.by(() => {
		if (!isSubagent) return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		return {
			description: (inp['description'] as string) ?? "",
			subagentType: (inp['subagent_type'] as string) ?? "general",
			prompt: (inp['prompt'] as string) ?? "",
			taskId: (inp['task_id'] as string) ?? undefined,
		};
	});

	/** Extract the spawned session ID from the task tool result, metadata,
	 *  or the tool input's task_id field. Each strategy correlates a specific
	 *  tool call to its session — generic session-list matching is intentionally
	 *  omitted because it cannot distinguish between multiple child sessions
	 *  and would return a stale/wrong session. */
	const subagentSessionId = $derived.by(() => {
		if (!isSubagent) return null;
		// 1. Input's task_id (present when resuming a previous task)
		if (taskInput?.taskId) return taskInput.taskId;
		// 2. Result text: "task_id: ses_xxxxx ..."
		if (message.result) {
			const match = message.result.match(/task_id:\s*(ses_\S+)/);
			if (match?.[1]) return match[1];
		}
		// 3. Metadata sessionId (forwarded from OpenCode's tool part state)
		const metaSessionId = (message.metadata as Record<string, unknown> | undefined)?.["sessionId"];
		if (typeof metaSessionId === "string" && metaSessionId) return metaSessionId;
		return null;
	});

	const agentLabel = $derived(
		taskInput
			? `${taskInput.subagentType} Agent`
			: "Agent"
	);

	const agentDescription = $derived(
		taskInput?.description ?? ""
	);

	function navigateToSubagent(e: MouseEvent) {
		e.stopPropagation();
		if (subagentSessionId) {
			wsSend({ type: "switch_session", sessionId: subagentSessionId });
		}
	}

	// ─── Generic tool display ───────────────────────────────────────────────

	const statusIconName = $derived.by(() => {
		switch (message.status) {
			case "running":
			case "pending":
				return "loader";
			case "completed":
				return "check";
			case "error":
				return "circle-alert";
			default:
				return "loader";
		}
	});

	const statusIconClass = $derived.by(() => {
		if (message.status === "running" || message.status === "pending")
			return "text-text-muted";
		if (message.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	const subtitleText = $derived.by(() => {
		switch (message.status) {
			case "pending":
				return "Pending…";
			case "running":
				return "Running…";
			case "completed":
				return "Done";
			case "error":
				return "Error";
			default:
				return "";
		}
	});

	const isStandalone = $derived(isFirstInGroup && isLastInGroup);

	const groupRadius = $derived.by(() => {
		if (isFirstInGroup && isLastInGroup) return "rounded-[10px]";
		if (isFirstInGroup) return "rounded-t-[10px]";
		if (isLastInGroup) return "rounded-b-[10px]";
		return "";
	});

	const resultErrorClass = $derived(
		message.isError ? "border-error/30 text-error" : "",
	);

	// Tool input summary (subtitle + tags)
	const toolSummary = $derived(extractToolSummary(message.name, message.input as Record<string, unknown> | undefined));

	// For Bash/Shell tools, extract the raw command for display in expanded view
	const bashCommand = $derived.by(() => {
		if (message.name !== "Bash") return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		const cmd = inp['command'] as string | undefined;
		return cmd ?? null;
	});

	// Description preview (prefer input subtitle, then first line of result, then status)
	const descText = $derived.by(() => {
		if (toolSummary.subtitle) return toolSummary.subtitle;
		if (message.result) {
			const firstLine = message.result.split("\n")[0] ?? "";
			return firstLine.length > 60
				? `${firstLine.slice(0, 60)}…`
				: firstLine;
		}
		if (message.status === "running") return "Running…";
		return "";
	});

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<!-- Active non-synthetic questions are deferred to the bottom of MessageList.
	 Hide the entire tool-item wrapper to avoid empty margin/padding. -->
{#if isDeferredQuestion}
	<!-- Rendered at bottom of MessageList instead -->
{:else}
<div
	class="tool-item max-w-[760px] mx-auto px-5"
	class:expanded
	class:mt-1.5={isFirstInGroup}
	class:mt-0.5={!isFirstInGroup}
	class:mb-0.5={!isLastInGroup}
	class:mb-1={isLastInGroup}
	data-tool-id={message.id}
>
{#if isQuestion}
	<!-- ─── Question / AskUserQuestion Card ────────────────────────────────── -->
	{#if isQuestionActive && questionRequest}
		<!-- Synthetic question (cross-process): keep inline since it's not in
			 pendingQuestions and won't appear at the bottom of MessageList. -->
		<QuestionCard request={questionRequest} inline synthetic />
	{:else}
		<!-- Completed/historical question: show read-only summary -->
		<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} {groupRadius} relative overflow-hidden {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
			{#if message.status === 'running'}
				<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
			{/if}
			<!-- Header row -->
			<div
				class="question-tool-header flex items-center gap-2.5 w-full py-2 px-3 text-xs text-text-dimmer"
			>
				<!-- Status icon -->
				{#if message.status === 'running'}
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
				{:else}
					<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
						<Icon name={statusIconName} size={14} />
					</span>
				{/if}

				<!-- Question icon -->
				<span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">
					<Icon name="message-square" size={16} />
				</span>

				<!-- Title -->
				<span class="font-medium text-text-dimmer">Input Required</span>

				<span class="flex-1"></span>
			</div>

			<!-- Question content (read-only) -->
			{#if questionData}
				<div class="px-3 pb-2">
					{#each questionData as q, qIdx}
						<div class="question-tool-section" class:mt-2={qIdx > 0}>
							{#if q.header}
								<div class="text-xs font-semibold text-accent font-mono mb-0.5">
									{q.header.charAt(0).toUpperCase() + q.header.slice(1)}
								</div>
							{/if}
							<div class="text-sm text-text-secondary mb-1.5">
								{q.question}
							</div>
							{#if q.options.length > 0}
								<div class="flex flex-col gap-1">
									{#each q.options as opt}
										<div class="flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-bg-surface border border-border-subtle">
											<span class="text-text-dimmer mt-0.5 shrink-0">○</span>
											<span class="flex flex-col gap-0.5">
												<span class="text-text font-medium text-[13px]">{opt.label}</span>
												{#if opt.description}
													<span class="text-text-muted text-xs">{opt.description}</span>
												{/if}
											</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Subtitle row -->
			<div
				class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
			>
				<span class="tool-connector font-mono not-italic text-border">└</span>
				{#if message.status === "completed" && !message.isError}
					<span class="tool-subtitle-text text-success not-italic">Answered ✓</span>
				{:else if message.status === "error"}
					<span class="tool-subtitle-text text-error not-italic">Skipped ✗</span>
				{:else}
					<span class="tool-subtitle-text">Waiting for answer…</span>
				{/if}
			</div>

			<!-- Show answer when completed -->
			{#if message.status === "completed" && questionAnswer}
				<div
					class="font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[200px] overflow-y-auto mb-2"
				>
					{questionAnswer}
				</div>
			{/if}
		</div>
	{/if}
{:else if isSubagent}
	<!-- ─── Subagent / Task Tool Card ──────────────────────────────────────── -->
	<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} {groupRadius} relative overflow-hidden {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
		{#if message.status === 'running'}
			<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
		{/if}
		<button
			class="subagent-header flex items-center gap-2.5 w-full py-2.5 px-3 text-xs text-text-dimmer transition-colors duration-150 border-none text-left select-none bg-transparent disabled:opacity-100 disabled:cursor-default {subagentSessionId ? 'cursor-pointer hover:bg-bg-surface' : ''}"
			onclick={navigateToSubagent}
			disabled={!subagentSessionId}
			title={subagentSessionId ? "Open subagent session" : undefined}
		>
			<!-- Status icon -->
			{#if message.status === 'running'}
				<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
			{:else}
				<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
					<Icon name={statusIconName} size={14} />
				</span>
			{/if}

			<!-- Agent icon -->
			<span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">
				<Icon name="bot" size={16} />
			</span>

			<!-- Agent label + description -->
			<div class="flex-1 min-w-0">
				<span class="agent-title text-text-dimmer font-medium capitalize">
					{agentLabel}
				</span>
				{#if agentDescription}
					<span
						class="subagent-link block text-xs text-text-dimmer truncate max-w-full mt-0.5"
						class:underline={!!subagentSessionId}
						class:hover:text-accent={!!subagentSessionId}
					>
						{agentDescription}
					</span>
				{/if}
			</div>

			<!-- Navigate arrow (only when session is available) -->
			{#if subagentSessionId}
				<span class="shrink-0 text-text-dimmer">
					<Icon name="arrow-right" size={14} />
				</span>
			{/if}
		</button>

		<!-- Subtitle row -->
		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>
	</div>
{:else}
	<!-- ─── Generic Tool Card ──────────────────────────────────────────────── -->
	<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} {groupRadius} relative overflow-hidden {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
		{#if message.status === 'running'}
			<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
		{/if}
		<button
			class="tool-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 border-none text-left"
			onclick={handleToggle}
		>
		<span
			class="tool-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
			class:rotate-90={expanded}
		>
			<Icon name="chevron-right" size={14} />
		</span>

		{#if message.status === 'running'}
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
		{:else}
			<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
				<Icon name={statusIconName} size={14} />
			</span>
		{/if}

		<span class="tool-name font-medium text-text-dimmer">
			{message.name}
		</span>

		<span
			class="tool-desc flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-dimmer"
		>
			{descText}
		</span>

		{#if toolSummary.tags}
			{#each toolSummary.tags as tag}
				<span class="px-1.5 py-0.5 rounded bg-[rgba(var(--overlay-rgb),0.05)] font-mono text-[11px] text-text-dimmer shrink-0">
					{tag}
				</span>
			{/each}
		{/if}
		</button>

		{#if message.status !== 'completed'}
		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>
		{/if}

		{#if expanded && (message.result || bashCommand)}
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-3 px-4 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[200px] overflow-y-auto {resultErrorClass}"
				class:is-error={message.isError}
			>
				{#if bashCommand}<span class="text-text-muted">$ {bashCommand}</span>{#if message.result}{"\n\n"}{/if}{/if}{#if message.result}{message.result}{/if}
			</div>

			{#if message.isTruncated && message.result}
				<div class="flex items-center gap-2 mx-2.5 mt-1 mb-1 text-xs text-text-dimmer">
					<span class="font-mono">
						Showing {formatKB(message.result.length)} of {formatKB(message.fullContentLength ?? message.result.length)}
					</span>
					<button
						class="px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors duration-150 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={requestFullContent}
						disabled={loadingFullContent}
					>
						{#if loadingFullContent}
							Loading…
						{:else}
							Show full output
						{/if}
					</button>
				</div>
			{/if}
		{/if}
	</div>
{/if}
</div>
{/if}

<!-- ─── Tool Question Card ────────────────────────────────────────────────── -->
<!-- Renders AskUserQuestion tool calls: interactive QuestionCard when active, -->
<!-- read-only summary when completed/historical. -->

<script lang="ts">
	import type { ToolMessage, QuestionRequest, AskUserQuestion } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";

	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';
	import QuestionCard from "./QuestionCard.svelte";

	let { message, groupRadius }: {
		message: ToolMessage;
		groupRadius: string;
	} = $props();

	// ─── Question detection ─────────────────────────────────────────────────
	// The question tool name is "AskUserQuestion" (mapped from "question").
	// When the question is active, render the interactive QuestionCard inline.
	// When completed/historical, show a read-only summary.

	/**
	 * Parse question data from the tool input.
	 * Used for rendering (both interactive and read-only) when no pending
	 * question match exists in the permissions store.
	 */
	const questionDataFromInput = $derived.by((): AskUserQuestion[] | null => {
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
			sessionId: "",
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
	 *  (i.e. not synthetic and has a pending question in the permissions store).
	 *  Note: ToolItem computes this independently to avoid circular mount deps. */
	const isDeferredQuestion = $derived(
		isQuestionActive && questionRequest !== null && !isSyntheticQuestion
	);

	/** Extract question data for read-only display.
	 *  Prefers the pending question request (accurate), falls back to tool input. */
	const questionData = $derived.by(() => {
		return pendingQuestionRequest?.questions ?? questionDataFromInput;
	});

	/** Parse the answer from the tool result text */
	const questionAnswer = $derived.by((): string | null => {
		if (!message.result) return null;
		return message.result;
	});

	// ─── Status display ─────────────────────────────────────────────────────

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
</script>

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
											<span class="text-text font-medium text-base">{opt.label}</span>
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

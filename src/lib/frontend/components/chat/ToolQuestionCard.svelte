<!-- Renders AskUserQuestion tool calls: interactive QuestionCard when active, -->
<!-- read-only summary when completed/historical. -->

<script lang="ts">
	import type { ToolMessage, QuestionRequest, AskUserQuestion } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { fmtDuration } from "../../utils/turns.js";

	import Icon from "../ui/Icon.svelte";
	import BlockGrid from '../ui/BlockGrid.svelte';
	import QuestionCard from "./QuestionCard.svelte";
	import Surface from "../ui/Surface.svelte";

	let { message }: {
		message: ToolMessage;
	} = $props();

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

		// Tertiary: content-match against pending questions to find the correct que_ ID.
		// Scoped to the viewed session: pending questions outlive switches, and
		// another session's identical text must not bind (answers go by toolId).
		const fallbackQuestions = questionDataFromInput;
		if (fallbackQuestions) {
			const contentMatch = permissionsState.pendingQuestions.find((pendingQuestion) => {
				if (pendingQuestion.sessionId !== sessionState.currentId) return false;
				if (pendingQuestion.questions.length !== fallbackQuestions.length) return false;
				return pendingQuestion.questions.every((question, i) => {
					const fallbackQuestion = fallbackQuestions[i];
					return fallbackQuestion && question.question === fallbackQuestion.question && question.header === fallbackQuestion.header;
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

	/** Extract question data for read-only display.
	 *  Prefers the pending question request (accurate), falls back to tool input. */
	const questionData = $derived.by(() => {
		return pendingQuestionRequest?.questions ?? questionDataFromInput;
	});

	// History returns results still JSON-encoded, so a question closed without an
	// answer reloads as the literal '""' rather than an empty string.
	const questionAnswer = $derived(
		message.result && message.result !== '""' ? message.result : null,
	);

	// An interrupted turn (Stop, or a message sent instead of answering) completes
	// the tool with no result, so "completed" alone does not mean answered.
	const isAnswered = $derived(
		message.status === "completed" && !message.isError && questionAnswer !== null,
	);
	const isUnanswered = $derived(message.status === "completed" && !isAnswered);
	const running = $derived(message.status === "running" || message.status === "pending");
	const duration = $derived(message.createdAt === undefined || (!running && message.endedAt === undefined) ? undefined : Math.max(0, (message.endedAt ?? clock.now) - message.createdAt));
</script>

<div class="min-w-0">
	<div class="question-tool-header flex items-center gap-[8px] min-h-[28px] py-[3px] text-[13px] text-text-secondary">
		<span class="tool-status-icon shrink-0 text-text-dimmer"><Icon name="message-square" size={14} /></span>
		<span class="shrink-0 font-semibold">{running ? "Asking" : "Asked"}</span>
		<span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">{questionData?.[0]?.question ?? "Input required"}</span>
		{#if duration !== undefined}<time class="ml-auto shrink-0 font-mono text-[12px] text-text-dimmer">{fmtDuration(duration)}</time>{/if}
		{#if running}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
		{:else if message.status === "error" || message.isError}<span class="shrink-0 text-error"><Icon name="circle-alert" size={12} /></span>{/if}
	</div>
{#if isQuestionActive && questionRequest}
	<QuestionCard request={questionRequest} inline synthetic={pendingQuestionRequest === null} />
{:else}
	<!-- Completed/historical question: show read-only summary -->
	<div class="pl-[22px] min-w-0">

		<!-- Question content (read-only) -->
		{#if questionData}
			<div class="pb-[8px]">
				{#each questionData as q, qIdx}
					<div class="question-tool-section" class:mt-2={qIdx > 0}>
						{#if q.header}
							<div class="text-[12px] font-semibold text-text-dimmer font-mono mb-[2px]">
								{q.header.charAt(0).toUpperCase() + q.header.slice(1)}
							</div>
						{/if}
						<div class="text-[13px] text-text-secondary mb-[6px]">
							{q.question}
						</div>
						{#if q.options.length > 0}
							<div class="flex flex-col gap-1">
								{#each q.options as opt}
									<div class="question-tool-option flex items-start gap-[8px] px-[10px] py-[6px] rounded-[6px] text-[12px] bg-bg-surface border border-border-subtle">
										<span class="text-text-dimmer mt-0.5 shrink-0">○</span>
										<span class="flex flex-col gap-0.5">
											<span class="text-text-secondary font-medium text-[13px]">{opt.label}</span>
											{#if opt.description}
												<span class="text-text-muted text-[12px]">{opt.description}</span>
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
			class="tool-subtitle pb-[3px] text-[12px] text-text-dimmer"
		>
			{#if isAnswered}
				<span class="tool-subtitle-text">Answered ✓</span>
			{:else if isUnanswered}
				<span class="tool-subtitle-text not-italic">Not answered</span>
			{:else if message.status === "error"}
				<span class="tool-subtitle-text text-error not-italic">Skipped ✗</span>
			{:else}
				<span class="tool-subtitle-text">Waiting for answer…</span>
			{/if}
		</div>

		<!-- Show answer when completed -->
		{#if isAnswered}
			<Surface
				variant="inset"
				radius="md"
				class="font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all my-[4px] py-[8px] px-[10px] text-text-secondary max-h-[200px] overflow-y-auto mb-[8px]"
			>
				{questionAnswer}
			</Surface>
		{/if}
	</div>
{/if}
</div>

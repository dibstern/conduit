<!-- Renders AskUserQuestion tool calls: interactive QuestionCard when active, -->
<!-- read-only summary when completed/historical. -->

<script lang="ts">
	import type { ToolMessage, QuestionRequest, AskUserQuestion } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { fmtDuration } from "../../utils/turns.js";

	import Icon from "../ui/Icon.svelte";
	import ConduitMark from '../ui/ConduitMark.svelte';
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
			isOther?: boolean;
			isSecret?: boolean;
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
			custom: q.custom ?? q.isOther ?? true,
			...(q.isOther != null && { isOther: q.isOther }),
			...(q.isSecret != null && { isSecret: q.isSecret }),
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

	const isAsync = $derived(
		pendingQuestionRequest?.delivery === "async" ||
		(message.input as Record<string, unknown> | null | undefined)?.['delivery'] === "async",
	);

	/** Whether the question is actively pending and should show an interactive card.
	 *  Async questions stay interactive after their turn and tool have completed.
	 *  Blocking questions are interactive when either:
	 *  1. The tool is running AND matched to a pendingQuestion (has server-side que_ ID), OR
	 *  2. The tool is running AND we have question data from the tool input (cross-process
	 *     case where GET /question returns empty, but the tool is still running). */
	const isQuestionActive = $derived(
		pendingQuestionRequest?.delivery === "async" ||
		((message.status === "pending" || message.status === "running") &&
			(pendingQuestionRequest !== null || questionDataFromInput !== null))
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
			...(isAsync && { delivery: "async" }),
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
	// Codex async questions use JSON null for their empty result.
	const questionAnswer = $derived(
		message.result && message.result !== '""' && (!isAsync || message.result !== "null") ? message.result : null,
	);
	const answerDisplay = $derived(
		questionData?.some((question) => question.isSecret)
			? "Secret answer hidden"
			: questionAnswer,
	);
	const parsedAnswers = $derived.by((): string[][] | null => {
		if (!questionData) return null;
		let result: unknown = questionAnswer;
		if (questionAnswer) {
			try { result = JSON.parse(questionAnswer); } catch { /* Plain provider text. */ }
		}
		const input = message.input as Record<string, unknown> | undefined;
		let answers: unknown = message.metadata?.['answers'] ?? input?.['answers'] ?? result;
		if (typeof answers === "object" && answers !== null && !Array.isArray(answers) && 'answers' in answers) {
			answers = answers.answers;
		}
		if (typeof answers === "string") {
			const byQuestion: Record<string, string> = {};
			// Claude's result contains quoted question/answer pairs, sometimes
			// wrapped in a JSON string by history persistence.
			for (const pair of answers.matchAll(/("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/g)) {
				try {
					byQuestion[JSON.parse(pair[1] ?? '""') as string] = JSON.parse(pair[2] ?? '""') as string;
				} catch { /* Unrecognised pairs retain the raw-result fallback. */ }
			}
			if (Object.keys(byQuestion).length === 0) return null;
			answers = byQuestion;
		}
		if (typeof answers !== "object" || answers === null) return null;
		const structured = answers;
		// A partially recognised payload still needs its raw fallback: silently
		// dropping an unfamiliar question or value would lose the user's answer.
		if (Array.isArray(structured)) {
			if (questionData.length > 1 && structured.length > questionData.length) return null;
		} else if (Object.keys(structured).some((key) => !questionData.some((question, index) => key === question.question || key === question.header || key === String(index)))) {
			return null;
		}
		const values = questionData.map((question, index): unknown => {
			if (Array.isArray(structured)) {
				return questionData.length === 1 ? structured.flat() : structured[index];
			}
			const byQuestion = structured as Record<string, unknown>;
			return byQuestion[question.question] ?? byQuestion[String(index)] ?? byQuestion[question.header];
		});
		if (values.some((value) => value !== undefined && typeof value !== "string" && (!Array.isArray(value) || value.some((answer: unknown) => typeof answer !== "string")))) return null;
		const parsed = questionData.map((question, index) => {
			const value = values[index];
			const answers = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
			return answers.flatMap((answer: unknown) => {
				if (typeof answer !== "string" || !answer.trim()) return [];
				const choices = answer.split(", ");
				return question.multiSelect && choices.every((choice) => question.options.some((option) => option.label === choice))
					? choices : [answer];
			});
		});
		return parsed.some((answers) => answers.length > 0) ? parsed : null;
	});

	// An interrupted turn (Stop, or a message sent instead of answering) completes
	// the tool with no result, so "completed" alone does not mean answered.
	const isAnswered = $derived(
		message.status === "completed" && !message.isError && (questionAnswer !== null || parsedAnswers !== null),
	);
	const isUnanswered = $derived(message.status === "completed" && !isAnswered);
	const isSkipped = $derived(message.status === "error" && /dismiss|skip|reject|declin/i.test(message.result ?? ""));
	const running = $derived(!isAsync && (message.status === "running" || message.status === "pending"));
	const duration = $derived(message.createdAt === undefined || (!running && message.endedAt === undefined) ? undefined : Math.max(0, (message.endedAt ?? clock.now) - message.createdAt));
</script>

<div class="min-w-0">
	<div class="question-tool-header flex items-center gap-[8px] h-[26px] text-[12.5px] text-text-muted">
		<span class="tool-status-icon shrink-0 text-text-dimmer"><Icon name="message-square" size={14} /></span>
		<span class="question-tool-verb shrink-0 font-normal">{running ? "Asking" : "Asked"}</span>
		<span class="question-tool-argument min-w-0 flex-1 truncate font-mono text-mono-code text-text-dimmer">{questionData?.[0]?.question ?? "Input required"}</span>
		{#if duration !== undefined}<time class="ml-auto shrink-0 font-mono text-mono-time text-text-dimmer">{fmtDuration(duration)}</time>{/if}
		{#if running}<ConduitMark size={16} variant="running" />
		{:else if !isSkipped && (message.status === "error" || message.isError)}<span class="shrink-0 text-error"><Icon name="circle-alert" size={12} /></span>{/if}
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
							<div class="text-mono-xs font-semibold text-text-dimmer font-mono mb-[2px]">
								{q.header.charAt(0).toUpperCase() + q.header.slice(1)}
							</div>
						{/if}
						<div class="text-[13px] text-text-secondary mb-[6px]">
							{q.question}
						</div>
						{#if q.options.length > 0}
							<div class="flex flex-col gap-1">
								{#each q.options as opt}
									{@const chosen = isAnswered && parsedAnswers?.[qIdx]?.includes(opt.label)}
									<div class="question-tool-option flex items-baseline gap-[8px] px-[10px] py-[6px] rounded-[6px] text-[13px] font-medium bg-bg-surface" data-chosen={chosen ? "true" : undefined}>
										<span class="question-tool-option-control shrink-0 {chosen ? 'text-accent' : 'text-text-dimmer'}" class:question-tool-checkbox={q.multiSelect} aria-hidden="true"></span>
										<span class="question-tool-option-content flex min-w-0 flex-col gap-0.5">
											<span class="question-tool-option-label text-text-secondary font-medium text-[13px]">{opt.label}</span>
											{#if opt.description}
												<span class="text-text-muted text-[12px] font-normal">{opt.description}</span>
											{/if}
										</span>
										{#if chosen}<span class="question-chosen ml-auto self-center shrink-0 rounded-full bg-accent/16 text-accent text-[11.5px] leading-none font-semibold px-[8px] py-[2px]">Chosen</span>{/if}
									</div>
								{/each}
							</div>
						{/if}
						{#each (isAnswered ? parsedAnswers?.[qIdx] ?? [] : []).filter((answer) => !q.options.some((option) => option.label === answer)) as answer}
							<p class="question-free-answer text-[13px] text-text-secondary whitespace-pre-wrap my-[6px]">{answer}</p>
						{/each}
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
			{:else if isAsync && (message.status === "completed" || message.status === "error")}
				<span class="tool-subtitle-text not-italic">Dismissed</span>
			{:else if isUnanswered}
				<span class="tool-subtitle-text not-italic">Not answered</span>
			{:else if isSkipped}
				<span class="tool-subtitle-text not-italic">Skipped</span>
			{:else if message.status === "error"}
				<span class="tool-subtitle-text text-error not-italic">Error</span>
			{:else}
				<span class="tool-subtitle-text">Waiting for answer…</span>
			{/if}
		</div>

		<!-- Show answer when completed -->
		{#if isAnswered && parsedAnswers === null}
			<Surface
				variant="inset"
				radius="md"
				class="question-raw-answer font-mono text-mono-xs leading-[1.6] whitespace-pre-wrap break-all my-[4px] py-[8px] px-[10px] text-text-secondary max-h-[200px] overflow-y-auto mb-[8px]"
			>
				{answerDisplay}
			</Surface>
		{/if}
	</div>
{/if}
</div>

<style>
	.question-tool-option-control {
		position: relative;
		width: 13px;
		height: 13px;
		border: 1.5px solid currentColor;
		border-radius: 50%;
		/* Empty controls share the label baseline, then center on its x-height. */
		transform: translateY(calc(50% - 0.5ex));
	}
	.question-tool-checkbox {
		border-radius: 3px;
	}
	[data-chosen="true"] .question-tool-option-control {
		background: currentColor;
	}
	[data-chosen="true"] .question-tool-option-control:not(.question-tool-checkbox) {
		box-shadow: inset 0 0 0 3px var(--color-bg-surface);
	}
	[data-chosen="true"] .question-tool-checkbox::after {
		content: "";
		position: absolute;
		left: 3px;
		top: 0;
		width: 4px;
		height: 7px;
		border: solid var(--color-bg);
		border-width: 0 1.5px 1.5px 0;
		transform: rotate(45deg);
	}
</style>

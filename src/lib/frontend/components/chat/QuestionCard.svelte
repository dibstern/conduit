<!-- ─── Question Card ──────────────────────────────────────────────────────── -->
<!-- Displays an interactive question form with radio/checkbox/custom input. -->
<!-- Preserves .question-card class and [data-question-tool-id] for E2E. -->

<script lang="ts">
	import type { QuestionRequest } from "../../types.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import {
		buildAnswerPayload,
		formatQuestionHeader,
		isValidSubmission,
		permissionsState,
	} from "../../stores/permissions.svelte.js";

	let { request, inline = false, synthetic = false }: { 
		request: QuestionRequest; 
		inline?: boolean;
		/** True when this question was reconstructed from tool input data
		 *  rather than received via a live `ask_user` WebSocket event.
		 *  This happens when viewing a session started outside this browser
		 *  (e.g. from the terminal). The answer may not be deliverable. */
		synthetic?: boolean;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────
	let resolved = $state<"submitted" | "submitting" | "skipped" | null>(null);

	/** Error message from the server when answer delivery fails. */
	let errorMessage = $state<string | null>(null);

	/** Timer for reverting from "submitting" to null on server error */
	let submitTimeout: ReturnType<typeof setTimeout> | undefined;

	// Selection state: question index -> selected value(s)
	let selections = $state(new Map<number, string>());

	// Custom text input values per question index
	let customTexts = $state(new Map<number, string>());

	// For multi-select: track checked options per question
	let multiChecked = $state(new Map<number, Set<string>>());

	// For single-select: track which option is selected per question
	let singleSelected = $state(new Map<number, string>());

	// ─── Watch for server errors on this question ────────────────────────────
	$effect(() => {
		const err = permissionsState.questionErrors.get(request.toolId);
		if (err) {
			errorMessage = err;
			// Revert to allow retry
			if (resolved === "submitting") {
				resolved = null;
			}
			clearTimeout(submitTimeout);
			// Clean up — don't keep showing on re-render
			permissionsState.questionErrors.delete(request.toolId);
		}
	});

	// ─── Derived ─────────────────────────────────────────────────────────────

	const canSubmit = $derived(isValidSubmission(selections, request.questions));

	// ─── Helpers ─────────────────────────────────────────────────────────────

	function rebuildSelections() {
		const next = new Map<number, string>();
		for (let qIdx = 0; qIdx < request.questions.length; qIdx++) {
			const q = request.questions[qIdx];
			if (q.multiSelect) {
				const checked = multiChecked.get(qIdx) ?? new Set();
				const values: string[] = [];
				for (const v of checked) {
					if (v === "__custom__") {
						const customVal = (customTexts.get(qIdx) ?? "").trim();
						if (customVal) values.push(customVal);
					} else {
						values.push(v);
					}
				}
				if (values.length > 0) {
					next.set(qIdx, values.join(", "));
				}
			} else {
				const selected = singleSelected.get(qIdx);
				if (selected === "__custom__") {
					const customVal = (customTexts.get(qIdx) ?? "").trim();
					if (customVal) {
						next.set(qIdx, customVal);
					}
				} else if (selected) {
					next.set(qIdx, selected);
				}
			}
		}
		selections = next;
	}

	function handleRadioChange(qIdx: number, value: string) {
		const next = new Map(singleSelected);
		next.set(qIdx, value);
		singleSelected = next;
		rebuildSelections();
	}

	function handleCheckboxChange(
		qIdx: number,
		value: string,
		checked: boolean,
	) {
		const nextMulti = new Map(multiChecked);
		const current = new Set(nextMulti.get(qIdx) ?? []);
		if (checked) {
			current.add(value);
		} else {
			current.delete(value);
		}
		nextMulti.set(qIdx, current);
		multiChecked = nextMulti;
		rebuildSelections();
	}

	function handleCustomTextInput(qIdx: number, value: string) {
		const next = new Map(customTexts);
		next.set(qIdx, value);
		customTexts = next;
		rebuildSelections();
	}

	function handleCustomFocus(qIdx: number, isMultiSelect: boolean) {
		if (isMultiSelect) {
			const nextMulti = new Map(multiChecked);
			const current = new Set(nextMulti.get(qIdx) ?? []);
			current.add("__custom__");
			nextMulti.set(qIdx, current);
			multiChecked = nextMulti;
		} else {
			const next = new Map(singleSelected);
			next.set(qIdx, "__custom__");
			singleSelected = next;
		}
		rebuildSelections();
	}

	function handleSubmit() {
		if (!canSubmit || resolved) return;
		errorMessage = null; // Clear any previous error
		const answers = buildAnswerPayload(selections, request.questions);
		wsSend({
			type: "ask_user_response",
			toolId: request.toolId,
			answers,
		});
		// Show "submitting" state until the server confirms with ask_user_resolved
		// (which removes this question from pendingQuestions, unmounting us).
		// If the server fails, an ask_user_error message will revert us immediately.
		// As a safety net, also revert after 10s if nothing happens.
		resolved = "submitting";
		clearTimeout(submitTimeout);
		submitTimeout = setTimeout(() => {
			if (resolved === "submitting") {
				resolved = null; // Revert — allow retry
				errorMessage = "No response from server. You can try again, or send a follow-up message to continue.";
			}
		}, 10_000);
	}

	function handleSkip() {
		if (resolved) return;
		wsSend({ type: "question_reject", toolId: request.toolId });
		resolved = "skipped";
	}

	function isRadioChecked(qIdx: number, value: string): boolean {
		return singleSelected.get(qIdx) === value;
	}

	function isCheckboxChecked(qIdx: number, value: string): boolean {
		return multiChecked.get(qIdx)?.has(value) ?? false;
	}
</script>

<div
	class={inline ? '' : 'my-2 mx-auto max-w-[760px] px-4'}
	data-question-tool-id={request.toolId}
>
	<div class="question-card bg-bg-alt border border-border rounded-xl p-3">
		<div class="question-title text-base font-medium mb-2 text-text">
			Input Required
		</div>

		{#if synthetic}
			<div class="question-synthetic-warning text-xs text-text-muted bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 mb-3 leading-relaxed">
				This question was asked in a terminal session. You can try answering here,
				but if it doesn't work, answer in the terminal or send a follow-up message
				to continue.
			</div>
		{/if}

		{#each request.questions as q, qIdx}
			{@const inputName = `question-${request.toolId}-${qIdx}`}
			<div class="question-section mb-3 last:mb-2" data-q-idx={qIdx}>
				<div
					class="question-header text-xs font-semibold mb-0.5 text-accent font-mono"
				>
					{formatQuestionHeader(q.header)}
				</div>
				<div class="question-text text-sm mb-2 text-text-secondary">
					{q.question}
				</div>

				{#if q.options.length > 0}
					<div class="question-options flex flex-col gap-1.5">
						{#each q.options as opt, optIdx}
							{@const optId = `${inputName}-opt-${optIdx}`}
							{#if q.multiSelect}
								<label
									class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg {isCheckboxChecked(qIdx, opt.label) ? 'border-accent bg-accent-bg' : ''}"
									for={optId}
								>
									<input
										type="checkbox"
										id={optId}
										name={inputName}
										value={opt.label}
										checked={isCheckboxChecked(
											qIdx,
											opt.label,
										)}
										disabled={!!resolved}
										onchange={(e) =>
											handleCheckboxChange(
												qIdx,
												opt.label,
												(e.target as HTMLInputElement)
													.checked,
											)}
										class="mt-0.5 shrink-0 accent-accent"
									/>
									<span
										class="question-option-content flex flex-col gap-0.5"
									>
										<span
											class="question-option-label text-sm font-medium text-text"
											>{opt.label}</span
										>
										{#if opt.description}
											<span
												class="question-option-desc text-xs text-text-muted"
												>{opt.description}</span
											>
										{/if}
									</span>
								</label>
							{:else}
								<label
									class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg {isRadioChecked(qIdx, opt.label) ? 'border-accent bg-accent-bg' : ''}"
									for={optId}
								>
									<input
										type="radio"
										id={optId}
										name={inputName}
										value={opt.label}
										checked={isRadioChecked(
											qIdx,
											opt.label,
										)}
										disabled={!!resolved}
										onchange={() =>
											handleRadioChange(
												qIdx,
												opt.label,
											)}
										class="mt-0.5 shrink-0 accent-accent"
									/>
									<span
										class="question-option-content flex flex-col gap-0.5"
									>
										<span
											class="question-option-label text-sm font-medium text-text"
											>{opt.label}</span
										>
										{#if opt.description}
											<span
												class="question-option-desc text-xs text-text-muted"
												>{opt.description}</span
											>
										{/if}
									</span>
								</label>
							{/if}
						{/each}
					</div>
				{/if}

				{#if q.custom}
					<div class="question-custom mt-1.5">
						{#if q.options.length > 0}
							{@const customOptId = `${inputName}-custom-radio`}
							{#if q.multiSelect}
								<label
									class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg {isCheckboxChecked(qIdx, '__custom__') ? 'border-accent bg-accent-bg' : ''}"
									for={customOptId}
								>
									<input
										type="checkbox"
										id={customOptId}
										name={inputName}
										value="__custom__"
										checked={isCheckboxChecked(
											qIdx,
											"__custom__",
										)}
										disabled={!!resolved}
										onchange={(e) =>
											handleCheckboxChange(
												qIdx,
												"__custom__",
												(e.target as HTMLInputElement)
													.checked,
											)}
										class="mt-0.5 shrink-0 accent-accent"
									/>
									<span
										class="question-option-content flex flex-col gap-0.5"
									>
										<span
											class="question-option-label text-sm font-medium text-text"
											>Other</span
										>
									</span>
								</label>
							{:else}
								<label
									class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg {isRadioChecked(qIdx, '__custom__') ? 'border-accent bg-accent-bg' : ''}"
									for={customOptId}
								>
									<input
										type="radio"
										id={customOptId}
										name={inputName}
										value="__custom__"
										checked={isRadioChecked(
											qIdx,
											"__custom__",
										)}
										disabled={!!resolved}
										onchange={() =>
											handleRadioChange(
												qIdx,
												"__custom__",
											)}
										class="mt-0.5 shrink-0 accent-accent"
									/>
									<span
										class="question-option-content flex flex-col gap-0.5"
									>
										<span
											class="question-option-label text-sm font-medium text-text"
											>Other</span
										>
									</span>
								</label>
							{/if}
						{/if}
						<input
							type="text"
							id={`${inputName}-custom`}
							class="question-custom-input w-full mt-1 px-2.5 py-2 rounded-lg text-sm bg-input-bg border border-border text-text font-sans outline-none transition-[border-color] duration-150 focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
							placeholder="Type your answer"
							disabled={!!resolved}
							value={customTexts.get(qIdx) ?? ""}
							oninput={(e) =>
								handleCustomTextInput(
									qIdx,
									(e.target as HTMLInputElement).value,
								)}
							onfocus={() =>
								handleCustomFocus(qIdx, q.multiSelect)}
						/>
					</div>
				{/if}
			</div>
		{/each}

		{#if errorMessage}
			<div class="question-error text-xs text-error bg-error/10 border border-error/20 rounded-lg px-3 py-2 mt-2">
				{errorMessage}
			</div>
		{/if}

		{#if !resolved}
			<div class="question-actions flex gap-2 mt-2 max-sm:flex-col">
				<button
					class="question-submit-btn min-h-12 flex-1 px-4 py-2 rounded-lg border cursor-pointer text-sm font-medium font-sans border-success/20 bg-success/10 text-success transition-[background] duration-150 hover:enabled:bg-success/15 disabled:opacity-40 disabled:cursor-not-allowed"
					disabled={!canSubmit}
					onclick={handleSubmit}
				>
					Submit
				</button>
				<button
					class="question-skip-btn min-h-12 flex-1 px-4 py-2 rounded-lg border cursor-pointer text-sm font-medium font-sans border-border text-error bg-transparent transition-[background] duration-150 hover:bg-error/[0.08]"
					onclick={handleSkip}
				>
					Skip
				</button>
			</div>
		{:else if resolved === "submitting"}
			<div class="question-actions flex gap-2 mt-2 max-sm:flex-col">
				<button
					class="question-submit-btn min-h-12 flex-1 px-4 py-2 rounded-lg border text-sm font-medium font-sans border-success/20 bg-success/10 text-success opacity-60 cursor-not-allowed"
					disabled
				>
					Submitting&hellip;
				</button>
			</div>
		{:else}
			<div class="question-resolved text-sm py-2">
				{#if resolved === "skipped"}
					<span class="question-resolved-skip text-error"
						>Skipped &#x2717;</span
					>
				{:else}
					<span class="question-resolved-ok text-success"
						>Answered &#x2713;</span
					>
				{/if}
			</div>
		{/if}
	</div>
</div>

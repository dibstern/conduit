<!-- Displays an interactive question form with radio/checkbox/custom input. -->
<!-- Preserves .question-card class and [data-question-tool-id] for E2E. -->

<script lang="ts">
	import Surface from "../ui/Surface.svelte";
	import ChoiceLabel from "../ui/ChoiceLabel.svelte";
	import type { QuestionRequest } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Radio from "../ui/Radio.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import {
		buildAnswerPayload,
		formatQuestionHeader,
		isValidSubmission,
		removeQuestion,
	} from "../../stores/permissions.svelte.js";

	let { request, inline = false, synthetic = false }: {
		request: QuestionRequest;
		inline?: boolean | undefined;
		/** True when this question was reconstructed from tool input data
		 *  rather than received from the approvals subscription.
		 *  This happens when viewing a session started outside this browser
		 *  (e.g. from the terminal). The answer may not be deliverable. */
		synthetic?: boolean | undefined;
	} = $props();
	const instanceId = $props.id();

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

	const canSubmit = $derived(isValidSubmission(selections, request.questions));
	const isAsync = $derived(request.delivery === "async");
	const canSkip = $derived(
		getDriverTraits(request.providerId)?.supportsQuestionSkip ?? true,
	);

	function rebuildSelections() {
		const next = new Map<number, string>();
		for (const [qIdx, q] of request.questions.entries()) {
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
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		const answers = buildAnswerPayload(selections, request.questions);
		void rpc("AnswerQuestion", {
			projectSlug,
			originId: getBrowserClientId(),
			commandId: crypto.randomUUID(),
			toolId: request.toolId,
			answers,
		})
			.then(() => {
				if (resolved === "submitting") {
					resolved = "submitted";
					clearTimeout(submitTimeout);
					removeQuestion(request.toolId);
				}
			})
			.catch((error) => {
				if (resolved === "submitting") {
					resolved = null;
				}
				errorMessage = failureLine(error, "No response from server. You can try again, or send a follow-up message to continue.");
				clearTimeout(submitTimeout);
			});
		// Show "submitting" state until the server confirms the answer; the
		// approvals subscription then removes this question. A refusal comes back
		// as the RPC's error and reverts us immediately. As a safety net, also
		// revert after 10s if nothing happens.
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
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		errorMessage = null;
		void rpc("RejectQuestion", {
			projectSlug,
			originId: getBrowserClientId(),
			commandId: crypto.randomUUID(),
			toolId: request.toolId,
		})
			.then(() => {
				if (isAsync) removeQuestion(request.toolId);
			})
			.catch((error) => {
				if (resolved === "skipped") resolved = null;
				errorMessage = failureLine(error, isAsync ? "Could not dismiss this question." : "Could not skip this question.");
			});
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
	class="question-form {inline ? '' : 'my-[8px] mx-auto max-w-[760px] px-[16px]'}"
	data-question-tool-id={request.toolId}
>
	<Surface variant="raised" radius="lg" class="question-card p-[12px]">
		{#if isAsync}
			<div class="flex items-center justify-between gap-[8px] mb-[8px]">
				<div class="question-title text-[13px] font-semibold text-text-secondary">Answer anytime</div>
				{#if !resolved}
					<Button variant="ghost" size="sm" icon="x" iconOnly ariaLabel="Dismiss question" touchTarget onclick={handleSkip} />
				{/if}
			</div>
		{:else}
			<div class="question-title text-[13px] font-semibold mb-[8px] text-text-secondary">
				Input Required
			</div>
		{/if}

		{#if synthetic && !resolved}
			<div class="question-synthetic-warning text-[12px] text-text-muted bg-bg-surface border border-border-subtle rounded-[6px] px-[12px] py-[8px] mb-[12px] leading-[1.6]">
				This question was asked in a terminal session. You can try answering here,
				but if it doesn't work, answer in the terminal or send a follow-up message
				to continue.
			</div>
		{/if}

		{#each request.questions as q, qIdx}
			{@const inputName = `question-${instanceId}-${request.toolId}-${qIdx}`}
			<div class="question-section mb-[12px] last:mb-[8px]" data-q-idx={qIdx}>
				<div
					class="question-header text-mono-xs font-semibold mb-[2px] text-text-dimmer font-mono"
				>
					{formatQuestionHeader(q.header)}
				</div>
				<div class="question-text text-[13px] mb-[8px] text-text-secondary">
					{q.question}
				</div>

				{#if q.options.length > 0}
					<div class="question-options flex flex-col gap-[6px]">
						{#each q.options as opt, optIdx}
							{@const optId = `${inputName}-opt-${optIdx}`}
							{#if q.multiSelect}
								<ChoiceLabel
									class="question-option" forId={optId} selected={isCheckboxChecked(qIdx, opt.label)} disabled={!!resolved}
								>
									<Checkbox
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
									/>
									<span
										class="question-option-content flex min-w-0 flex-col gap-[2px]"
									>
										<span
											class="question-option-label text-[13px] font-medium text-text"
											>{opt.label}</span
										>
										{#if opt.description}
											<span
												class="question-option-desc text-[12px] font-normal text-text-muted"
												>{opt.description}</span
											>
										{/if}
									</span>
								</ChoiceLabel>
							{:else}
								<ChoiceLabel
									class="question-option" forId={optId} selected={isRadioChecked(qIdx, opt.label)} disabled={!!resolved}
								>
									<Radio
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
									/>
									<span
										class="question-option-content flex min-w-0 flex-col gap-[2px]"
									>
										<span
											class="question-option-label text-[13px] font-medium text-text"
											>{opt.label}</span
										>
										{#if opt.description}
											<span
												class="question-option-desc text-[12px] font-normal text-text-muted"
												>{opt.description}</span
											>
										{/if}
									</span>
								</ChoiceLabel>
							{/if}
						{/each}
					</div>
				{/if}

				{#if q.custom || q.isSecret}
					<div class="question-custom mt-[6px]">
						{#if q.options.length > 0}
							{@const customOptId = `${inputName}-custom-radio`}
							{#if q.multiSelect}
								<ChoiceLabel
									class="question-option" forId={customOptId} selected={isCheckboxChecked(qIdx, '__custom__')} disabled={!!resolved}
								>
									<Checkbox
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
									/>
									<span
										class="question-option-content flex min-w-0 flex-col gap-[2px]"
									>
										<span
											class="question-option-label text-[13px] font-medium text-text"
											>Other</span
										>
									</span>
								</ChoiceLabel>
							{:else}
								<ChoiceLabel
									class="question-option" forId={customOptId} selected={isRadioChecked(qIdx, '__custom__')} disabled={!!resolved}
								>
									<Radio
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
									/>
									<span
										class="question-option-content flex min-w-0 flex-col gap-[2px]"
									>
										<span
											class="question-option-label text-[13px] font-medium text-text"
											>Other</span
										>
									</span>
								</ChoiceLabel>
							{/if}
						{/if}
						<TextInput
							id={`${inputName}-custom`}
							type={q.isSecret ? "password" : "text"}
							autocomplete={q.isSecret ? "off" : undefined}
							aria-label="Type your answer"
							class="mt-[4px]"
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
			<div class="question-error text-[12px] text-error bg-error/10 border border-error/20 rounded-[6px] px-[12px] py-[8px] mt-[8px]">
				{errorMessage}
			</div>
		{/if}

		{#if !resolved}
			<div class="question-actions flex flex-wrap gap-[8px] mt-[12px]">
				<Button
					variant="chip"
					size="phone-card-action"
					touchTarget="always"
					class="question-submit-btn font-medium font-sans"
					disabled={!canSubmit}
					onclick={handleSubmit}
				>
					Submit
				</Button>
				{#if canSkip && !isAsync}
					<Button
						variant="chip"
						size="phone-card-action"
						touchTarget="always"
						class="question-skip-btn font-medium font-sans"
						onclick={handleSkip}
					>
						Skip
					</Button>
				{/if}
			</div>
		{:else if resolved === "submitting"}
			<div class="question-actions flex gap-[8px] mt-[12px]">
				<Button
					variant="chip"
					size="phone-card-action"
					touchTarget="always"
					layout="flow"
					hoverFill="none"
					disabledStyle="none"
					class="question-submit-btn font-medium font-sans opacity-60 cursor-not-allowed"
					disabled
				>
					Submitting&hellip;
				</Button>
			</div>
		{:else}
			<div class="question-resolved text-[13px] py-[8px]">
				{#if resolved === "skipped"}
					<span class="question-resolved-skip text-text-dimmer"
						>{isAsync ? "Dismissed" : "Skipped"}</span
					>
				{:else}
					<span class="question-resolved-ok text-success"
						>Answered &#x2713;</span
					>
				{/if}
			</div>
		{/if}
	</Surface>
</div>

<style>
	.question-form :global(.question-option) {
		border: 0;
		min-height: 0;
		align-items: baseline;
		font-weight: 500;
	}
	.question-form :global(.question-option:has(input:checked)) {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
	}
	@media (pointer: coarse) {
		.question-form :global(.question-option) {
			min-height: 44px;
			flex-wrap: wrap;
			align-content: center;
		}
		.question-form :global(.question-option-content) {
			flex: 1;
		}
	}
	.question-form :global(input[type="radio"]),
	.question-form :global(input[type="checkbox"]) {
		appearance: none;
		position: relative;
		margin: 0;
		font: inherit;
		width: 13px;
		height: 13px;
		border: 1.5px solid var(--color-text-dimmer);
		background: transparent;
		/* A replaced control's baseline is its bottom edge. Center it on the font's x-height. */
		transform: translateY(calc(50% - 0.5ex));
	}
	.question-form :global(input[type="radio"]) {
		border-radius: 50%;
	}
	.question-form :global(input[type="checkbox"]) {
		border-radius: 3px;
	}
	.question-form :global(input:checked) {
		border-color: var(--color-accent);
		background: var(--color-accent);
	}
	.question-form :global(input[type="radio"]:checked) {
		box-shadow: inset 0 0 0 3px var(--color-bg-surface);
	}
	.question-form :global(input[type="checkbox"]:checked)::after {
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

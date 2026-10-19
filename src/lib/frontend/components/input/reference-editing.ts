import { tick } from "svelte";
import {
	displayOffset,
	draftOffset,
	editReferenceDraft,
	encodeReference,
	projectReferences,
	type ReplyReference,
} from "../../../composer-references.js";

/** Native textarea offsets describe short labels; persisted offsets include payloads. */
export function referenceEditing(options: {
	read: () => string;
	write: (draft: string) => void;
	context: () => string;
	element: () => HTMLTextAreaElement | undefined;
	changed: () => void;
}) {
	let pendingEdit:
		| { start: number; end: number; text?: string | undefined }
		| undefined;
	let pendingHistory: -1 | 1 | undefined;
	// Where the last typed word ended: typing on from there extends one undo step.
	let typingAt: number | undefined;
	let typing = false;
	function snapshot() {
		const el = options.element();
		return {
			draft: options.read(),
			start: el?.selectionStart ?? 0,
			end: el?.selectionEnd ?? 0,
			direction: el?.selectionDirection ?? "none",
		};
	}
	let history: ReturnType<typeof snapshot>[] = [];
	let historyIndex = 0;
	let historyContext: string | undefined;
	function syncHistory() {
		// Restores, remote syncs and session changes begin a new local history.
		if (
			historyContext !== options.context() ||
			history[historyIndex]?.draft !== options.read()
		) {
			historyContext = options.context();
			history = [snapshot()];
			historyIndex = 0;
		}
	}
	function focusAt(
		start: number,
		end = start,
		direction: HTMLTextAreaElement["selectionDirection"] = "none",
	) {
		const draft = options.read();
		const context = options.context();
		const el = options.element();
		if (el) {
			const text = projectReferences(draft).text;
			// Assigning the value, even an equal one, drops the native undo stack.
			if (el.value !== text) el.value = text;
			el.setSelectionRange(start, end, direction);
		}
		void tick().then(() => {
			if (options.read() !== draft || options.context() !== context) return;
			const el = options.element();
			el?.focus();
			el?.setSelectionRange(start, end, direction);
		});
	}
	function commit(draft: string, caret?: number, extend = false) {
		syncHistory();
		options.write(draft);
		if (caret !== undefined) focusAt(caret);
		if (!extend) historyIndex++;
		history.splice(historyIndex, history.length, snapshot());
		options.changed();
	}
	/** Until a reference is involved, the browser's own undo is the better one. */
	function ownsHistory() {
		return [options.read(), ...history.map((entry) => entry.draft)].some(
			(draft) => projectReferences(draft).references.length > 0,
		);
	}
	function moveHistory(direction: -1 | 1) {
		pendingEdit = undefined;
		pendingHistory = undefined;
		typingAt = undefined;
		syncHistory();
		const next = history[historyIndex + direction];
		if (!next) {
			const current = history[historyIndex];
			if (current) focusAt(current.start, current.end, current.direction);
			return;
		}
		history[historyIndex] = snapshot();
		historyIndex += direction;
		options.write(next.draft);
		focusAt(next.start, next.end, next.direction);
		options.changed();
	}
	function selection() {
		const el = options.element();
		const draft = options.read();
		return {
			start: draftOffset(draft, el?.selectionStart ?? 0),
			end: draftOffset(draft, el?.selectionEnd ?? 0, "end"),
		};
	}
	function select() {
		const el = options.element();
		if (!el) return;
		let start = el.selectionStart;
		let end = el.selectionEnd;
		for (const span of projectReferences(options.read()).references) {
			if (
				start === end &&
				start > span.displayStart &&
				start < span.displayEnd
			) {
				start = end =
					start - span.displayStart < span.label.length / 2
						? span.displayStart
						: span.displayEnd;
			} else if (start < end) {
				if (start > span.displayStart && start < span.displayEnd)
					start = span.displayStart;
				if (end > span.displayStart && end < span.displayEnd)
					end = span.displayEnd;
			}
		}
		if (start !== el.selectionStart || end !== el.selectionEnd)
			el.setSelectionRange(start, end, el.selectionDirection);
	}
	return {
		selection,
		select,
		focusRaw: (offset: number) =>
			focusAt(displayOffset(options.read(), offset)),
		input(next: string) {
			const extend = typing;
			typing = false;
			if (pendingHistory !== undefined) {
				moveHistory(pendingHistory);
				return;
			}
			const draft = options.read();
			const view = projectReferences(draft);
			// A binding update after restore/sync is not a new local edit.
			if (next === view.text) {
				pendingEdit = undefined;
				return;
			}
			if (!view.references.length) commit(next, undefined, extend);
			else {
				const edit = editReferenceDraft(draft, next, pendingEdit);
				const corrected = projectReferences(edit.draft).text;
				commit(
					edit.draft,
					corrected !== next ? edit.caret : undefined,
					extend && corrected === next,
				);
			}
			pendingEdit = undefined;
		},
		insert(reference: ReplyReference) {
			pendingEdit = undefined;
			const draft = options.read();
			const range = selection();
			const before = draft.slice(0, range.start);
			const after = draft.slice(range.end);
			// A token is separated from its neighbours by one space, and the caret
			// lands after it, ready to type.
			const token = `${/(^|\s)$/.test(before) ? "" : " "}${encodeReference(reference)}${after.startsWith(" ") ? "" : " "}`;
			syncHistory();
			history[historyIndex] = snapshot();
			typingAt = undefined;
			const next = before + token + after;
			commit(
				next,
				displayOffset(
					next,
					range.start + token.length + (after.startsWith(" ") ? 1 : 0),
				),
			);
		},
		remove(start: number) {
			pendingEdit = undefined;
			const draft = options.read();
			const span = projectReferences(draft).references.find(
				(span) => span.start === start,
			);
			if (!span) return;
			syncHistory();
			history[historyIndex] = snapshot();
			typingAt = undefined;
			// Insertion spaced the token out; removing it takes one space along.
			const before = draft.slice(0, span.start);
			const end =
				/(^|\s)$/.test(before) && draft[span.end] === " "
					? span.end + 1
					: span.end;
			commit(before + draft.slice(end), span.displayStart);
		},
		beforeInput(event: InputEvent) {
			const el = options.element();
			pendingEdit = undefined;
			if (!el) return;
			if (
				(event.inputType === "historyUndo" ||
					event.inputType === "historyRedo") &&
				ownsHistory()
			) {
				const direction = event.inputType === "historyUndo" ? -1 : 1;
				if (event.cancelable) {
					event.preventDefault();
					moveHistory(direction);
				} else pendingHistory = direction;
				return;
			}
			pendingHistory = undefined;
			syncHistory();
			history[historyIndex] = snapshot();
			typing =
				event.inputType === "insertText" &&
				el.selectionStart === el.selectionEnd &&
				el.selectionStart === typingAt;
			let start = el.selectionStart;
			let end = el.selectionEnd;
			const collapsed = start === end;
			if (start === end && event.inputType === "deleteContentBackward")
				start = Math.max(0, start - 1);
			if (start === end && event.inputType === "deleteContentForward") end++;
			for (const span of projectReferences(options.read()).references) {
				if (start < span.displayEnd && end > span.displayStart) {
					start = Math.min(start, span.displayStart);
					end = Math.max(end, span.displayEnd);
				}
			}
			if (
				!collapsed ||
				event.inputType.startsWith("insert") ||
				["deleteContentBackward", "deleteContentForward"].includes(
					event.inputType,
				)
			)
				pendingEdit = {
					start,
					end,
					text: event.inputType.startsWith("delete")
						? ""
						: (event.data ?? event.dataTransfer?.getData("text/plain")),
				};
			typingAt =
				event.inputType === "insertText" && !/\s/.test(event.data ?? "")
					? start + (event.data?.length ?? 0)
					: undefined;
			// Native editing handles the keystroke; history retains the encoded draft.
			if (
				event.cancelable &&
				start !== end &&
				(start !== el.selectionStart || end !== el.selectionEnd)
			)
				el.setSelectionRange(start, end);
		},
		keydown(event: KeyboardEvent): boolean {
			const el = options.element();
			if (
				el &&
				!event.altKey &&
				!event.isComposing &&
				(event.metaKey || event.ctrlKey)
			) {
				const key = event.key.toLowerCase();
				if ((key === "z" || (event.ctrlKey && key === "y")) && ownsHistory()) {
					event.preventDefault();
					moveHistory(key === "y" || event.shiftKey ? 1 : -1);
					return true;
				}
			}
			if (
				!el ||
				event.altKey ||
				event.metaKey ||
				event.ctrlKey ||
				event.isComposing ||
				!["ArrowLeft", "ArrowRight"].includes(event.key)
			)
				return false;
			const left = event.key === "ArrowLeft";
			const caret =
				el.selectionDirection === "backward"
					? el.selectionStart
					: el.selectionEnd;
			const span = projectReferences(options.read()).references.find((span) =>
				left
					? caret > span.displayStart && caret <= span.displayEnd
					: caret >= span.displayStart && caret < span.displayEnd,
			);
			if (!span) return false;
			event.preventDefault();
			const to = left ? span.displayStart : span.displayEnd;
			if (event.shiftKey) {
				const anchor =
					el.selectionDirection === "backward"
						? el.selectionEnd
						: el.selectionStart;
				el.setSelectionRange(
					Math.min(anchor, to),
					Math.max(anchor, to),
					to < anchor ? "backward" : "forward",
				);
			} else el.setSelectionRange(to, to);
			return true;
		},
	};
}

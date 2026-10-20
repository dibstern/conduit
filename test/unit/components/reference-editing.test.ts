import { describe, expect, it } from "vitest";
import {
	encodeReference,
	projectReferences,
	serializeReferences,
} from "../../../src/lib/composer-references.js";
import { referenceEditing } from "../../../src/lib/frontend/components/input/reference-editing.js";

const excerpt =
	"The badge explains the shift. Keep every character of this excerpt.";
const token = encodeReference({ kind: "recap-excerpt", text: excerpt });

function composer(initial: string) {
	let draft = initial;
	let context = "first-session";
	const element = document.createElement("textarea");
	element.value = projectReferences(draft).text;
	const editor = referenceEditing({
		read: () => draft,
		write: (next) => {
			draft = next;
		},
		context: () => context,
		element: () => element,
		changed: () => {},
	});
	return {
		editor,
		element,
		read: () => draft,
		restore(next: string, session = context) {
			draft = next;
			context = session;
			element.value = projectReferences(next).text;
		},
		edit(inputType: string, text = "") {
			editor.beforeInput(
				new InputEvent("beforeinput", { inputType, cancelable: true }),
			);
			element.setRangeText(
				text,
				element.selectionStart,
				element.selectionEnd,
				"end",
			);
			editor.input(element.value);
		},
		key(key: string, modifiers: KeyboardEventInit = { metaKey: true }) {
			return editor.keydown(
				new KeyboardEvent("keydown", { key, cancelable: true, ...modifiers }),
			);
		},
	};
}

// Failure modes: label-only undo, lost replacement payloads, stale redo, identical
// labels with different payloads, history crossing a session/sync boundary, and
// an input path that ignores the widened selection and leaves label remnants.
describe("encoded composer undo history", () => {
	it("removes the whole chip when the edit ignores the widened selection", () => {
		const draft = `Before ${token} after`;
		const input = composer(draft);
		const span = projectReferences(draft).references[0];
		if (!span) throw new Error("Reference fixture is missing");
		input.element.setSelectionRange(span.displayEnd, span.displayEnd);
		input.editor.beforeInput(
			new InputEvent("beforeinput", {
				inputType: "deleteContentBackward",
				cancelable: true,
			}),
		);
		// Delete one character at the original caret, not the widened range.
		input.element.setRangeText("", span.displayEnd - 1, span.displayEnd);
		input.editor.input(input.element.value);
		expect(input.read()).toBe("Before  after");
		expect(input.element.value).toBe("Before  after");
	});

	it("restores the complete reference after Backspace and Cmd+Z, including redo", () => {
		const draft = `Before ${token} after`;
		const input = composer(draft);
		const span = projectReferences(draft).references[0];
		if (!span) throw new Error("Reference fixture is missing");
		const end = span.displayEnd;
		input.element.setSelectionRange(end, end);
		input.edit("deleteContentBackward");
		expect(input.read()).toBe("Before  after");
		expect(input.key("z")).toBe(true);
		expect(input.read()).toBe(draft);
		expect(serializeReferences(input.read())).toBe(
			`Re recap: "${excerpt}"\n\nBefore after`,
		);
		expect(input.element.selectionStart).toBe(end);
		input.key("z", { metaKey: true, shiftKey: true });
		expect(input.read()).toBe("Before  after");
		input.key("z");
		expect(input.read()).toBe(draft);
	});

	it("undoes and redoes a selection replacement without reconstructing its label", () => {
		const draft = `Before ${token} after`;
		const input = composer(draft);
		const span = projectReferences(draft).references[0];
		if (!span) throw new Error("Reference fixture is missing");
		input.element.setSelectionRange(span.displayStart + 2, span.displayEnd - 2);
		input.editor.select();
		input.edit("insertText", "replacement");
		expect(input.read()).toBe("Before replacement after");
		input.key("z", { ctrlKey: true });
		expect(input.read()).toBe(draft);
		expect(input.element.selectionStart).toBe(span.displayStart);
		expect(input.element.selectionEnd).toBe(span.displayEnd);
		input.key("y", { ctrlKey: true });
		expect(input.read()).toBe("Before replacement after");
	});

	it("undoes chip insertion and removal, retaining distinct payloads behind identical labels", () => {
		const input = composer("");
		input.editor.insert({ kind: "recap-excerpt", text: `${excerpt} First.` });
		input.editor.insert({ kind: "recap-excerpt", text: `${excerpt} Second.` });
		const draft = input.read();
		input.editor.remove(0);
		input.key("z");
		expect(input.read()).toBe(draft);
		input.key("z");
		expect(
			projectReferences(input.read()).references.map(
				(span) => span.reference.text,
			),
		).toEqual([`${excerpt} First.`]);
		input.key("z");
		expect(input.read()).toBe("");
	});

	it("handles native history input and discards redo after a new edit", () => {
		const input = composer(token);
		input.element.setSelectionRange(
			input.element.value.length,
			input.element.value.length,
		);
		input.edit("deleteContentBackward");
		const undo = new InputEvent("beforeinput", {
			inputType: "historyUndo",
			cancelable: true,
		});
		input.editor.beforeInput(undo);
		expect(undo.defaultPrevented).toBe(true);
		expect(input.read()).toBe(token);
		input.edit("insertText", " new text");
		input.key("z", { metaKey: true, shiftKey: true });
		expect(input.read()).toBe(`${token} new text`);
	});

	it("does not resurrect another session or overwrite a synchronized draft", () => {
		const input = composer(token);
		input.editor.remove(0);
		input.restore("", "second-session");
		input.key("z");
		expect(input.read()).toBe("");
		input.editor.insert({ kind: "recap-excerpt", text: "Local" });
		input.restore(`${token} remote text`);
		input.key("z");
		expect(input.read()).toBe(`${token} remote text`);
	});

	it("corrects noncancelable native history input even after history was reset", () => {
		const input = composer(token);
		input.editor.remove(0);
		const undo = new InputEvent("beforeinput", { inputType: "historyUndo" });
		input.editor.beforeInput(undo);
		input.element.value = projectReferences(token).text;
		input.editor.input(input.element.value);
		expect(input.read()).toBe(token);
		input.restore("", "second-session");
		input.editor.beforeInput(undo);
		input.element.value = projectReferences(token).text;
		input.editor.input(input.element.value);
		expect(input.read()).toBe("");
		expect(input.element.value).toBe("");
	});
});

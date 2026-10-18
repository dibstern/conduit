import {
	projectReferences,
	type ReplyReference,
} from "../../../composer-references.js";

export type { ReplyReference } from "../../../composer-references.js";

/** The one handle the mounted composer lends to cards and summaries. */
interface ComposerDraft {
	sessionId(): string | null;
	draft(): string;
	insert(reference: ReplyReference): void;
	remove(start: number): void;
}
// Read through, never copied, so what a card shows can't drift from the draft.
let composer = $state.raw<ComposerDraft | undefined>();

export function provideComposerDraft(next: ComposerDraft): () => void {
	composer = next;
	return () => {
		if (composer === next) composer = undefined;
	};
}

export function insertComposerReference(
	reference: ReplyReference,
	sessionId: string,
): void {
	if (composer?.sessionId() === sessionId) composer.insert(reference);
}

/** Where each whole-message reply starts in the session's draft, by ordinal. */
export function messageReplies(
	sessionId: string | undefined,
): ReadonlyMap<number, number> {
	const draft =
		sessionId && composer?.sessionId() === sessionId ? composer.draft() : "";
	return new Map(
		projectReferences(draft).references.flatMap(({ start, reference }) =>
			reference.kind === "message" ? [[reference.ordinal, start] as const] : [],
		),
	);
}

export function removeComposerReference(
	sessionId: string,
	start: number,
): void {
	if (composer?.sessionId() === sessionId) composer.remove(start);
}

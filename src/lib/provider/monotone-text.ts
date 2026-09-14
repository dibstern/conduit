// ─── Monotone Text ──────────────────────────────────────────────────────────
// The one place text is allowed to leave a translator.
//
// Both Provider Runtimes describe a growing piece of assistant text twice: as
// chunks on a stream, and as the whole text so far in a later snapshot. The
// only safe way to turn the second into an event is to emit the part of it that
// extends what already went out — and to emit nothing at all when it doesn't
// extend it, because re-slicing a rewritten text at the old length is what
// splices one sentence onto the tail of another.
//
// So this module holds, per part, the exact text already emitted, and offers
// exactly one way out: a suffix of that text. Accepted text never shrinks and
// is never rewritten, which makes a splice unrepresentable rather than guarded
// against. A part nothing has been emitted for accepts any text, since every
// string extends the empty one.

/** What may leave for a part, given the whole text a provider now reports. */
export type Offer =
	/** `fullText` extends what was emitted: this is the part that has not been. */
	| { readonly kind: "emit"; readonly suffix: string }
	/** `fullText` is exactly what was emitted; there is nothing to send. */
	| { readonly kind: "noop" }
	/** `fullText` is not an extension — it was rewritten, reordered or
	 *  truncated. Nothing leaves; `accepted` is what stands, for diagnostics. */
	| { readonly kind: "diverged"; readonly accepted: string };

export class MonotoneText {
	private readonly accepted = new Map<string, string>();

	/** Offer the whole text a provider reports for a part. */
	offer(partId: string, fullText: string): Offer {
		const accepted = this.accepted.get(partId) ?? "";
		if (fullText === accepted) return { kind: "noop" };
		if (!fullText.startsWith(accepted)) return { kind: "diverged", accepted };
		this.accepted.set(partId, fullText);
		return { kind: "emit", suffix: fullText.slice(accepted.length) };
	}

	/** Record a streamed chunk, which extends the part by construction, and
	 *  hand it straight back so callers never hold text this module hasn't
	 *  accepted. */
	append(partId: string, chunk: string): string {
		this.accepted.set(partId, (this.accepted.get(partId) ?? "") + chunk);
		return chunk;
	}

	forget(partId: string): void {
		this.accepted.delete(partId);
	}
}

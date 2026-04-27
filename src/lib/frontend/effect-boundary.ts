// ─── Frontend Effect Boundary ───────────────────────────────────────────────
// Lazy-loaded Schema validation for incoming daemon→client WebSocket messages.
// Validates against RelayMessageSchema (the full union of relay message types).
//
// Design:
//   - Lazy import: Schema module (~50KB) is code-split via dynamic import,
//     keeping it out of the main Vite bundle.
//   - Cached decoder: The Schema decoder is created once on first call and
//     reused for all subsequent messages.
//   - Graceful degradation: Unknown or invalid messages pass through unchanged
//     instead of being rejected. This ensures forward compatibility when the
//     daemon sends new message types the frontend doesn't know about yet.
//
// Uses RelayMessageSchema from shared-types.ts (daemon → client direction),
// NOT IncomingWsMessage from ws-message-schemas.ts (client → daemon direction).

let _decoder: ((raw: unknown) => unknown) | null = null;

const getDecoder = async (): Promise<(raw: unknown) => unknown> => {
	if (_decoder) return _decoder;

	// Lazy-load Effect and the Schema — keeps these out of the main bundle
	const [{ Schema }, { RelayMessageSchema }] = await Promise.all([
		import("effect"),
		import("../shared-types.js"),
	]);

	const decode = Schema.decodeUnknownEither(RelayMessageSchema);

	_decoder = (raw: unknown): unknown => {
		const result = decode(raw);
		// Either.isRight — valid message; return decoded value
		// Either.isLeft  — unknown/invalid; pass through raw for graceful degradation
		return result._tag === "Right" ? result.right : raw;
	};

	return _decoder;
};

/**
 * Validate an incoming daemon→client WebSocket message using RelayMessageSchema.
 *
 * Known message types are decoded and returned with schema-validated fields.
 * Unknown or invalid messages pass through unchanged (graceful degradation).
 *
 * The Schema module is lazy-loaded on first call for code-splitting.
 */
export const validateIncomingMessage = async (
	raw: unknown,
): Promise<unknown> => {
	const decode = await getDecoder();
	return decode(raw);
};

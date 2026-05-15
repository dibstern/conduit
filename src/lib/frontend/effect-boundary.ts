// ─── Frontend Effect Boundary ───────────────────────────────────────────────
// Lazy-loaded Schema validation for incoming daemon→client WebSocket messages.
// Validates against RelayMessageSchema (the full union of relay message types).
//
// Design:
//   - Lazy import: Schema module (~50KB) is code-split via dynamic import,
//     keeping it out of the main Vite bundle.
//   - Cached decoder: The Schema decoder is created once on first call and
//     reused for all subsequent messages.
//   - Graceful degradation: Unknown future message types pass through unchanged.
//   - Protocol correctness: Known message types that fail schema validation are
//     rejected so bad server payloads do not enter application state.
//
// Uses RelayMessageSchema from shared-types.ts (daemon → client direction),
// NOT IncomingWsMessage from ws-message-schemas.ts (client → daemon direction).

export class ProtocolDecodeError extends Error {
	readonly raw: unknown;
	readonly messageType: string;
	readonly cause: unknown;

	constructor(options: {
		messageType: string;
		raw: unknown;
		cause: unknown;
	}) {
		super(`Invalid relay message for type "${options.messageType}"`);
		this.name = "ProtocolDecodeError";
		this.raw = options.raw;
		this.messageType = options.messageType;
		this.cause = options.cause;
	}
}

let _decoder: ((raw: unknown) => unknown) | null = null;

const passthroughDecoder = (raw: unknown): unknown => raw;

const getMessageType = (raw: unknown): string | undefined => {
	if (typeof raw !== "object" || raw === null) return undefined;
	const type = (raw as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
};

const getDecoder = async (): Promise<(raw: unknown) => unknown> => {
	if (_decoder) return _decoder;

	// Lazy-load Effect and the Schema — keeps these out of the main bundle
	const [{ Schema }, { KNOWN_RELAY_MESSAGE_TYPES, RelayMessageSchema }] =
		await Promise.all([import("effect"), import("../shared-types.js")]);

	const decode = Schema.decodeUnknownEither(RelayMessageSchema);

	_decoder = (raw: unknown): unknown => {
		const result = decode(raw);
		if (result._tag === "Right") return result.right;

		const messageType = getMessageType(raw);
		if (messageType && KNOWN_RELAY_MESSAGE_TYPES.has(messageType)) {
			throw new ProtocolDecodeError({
				messageType,
				raw,
				cause: result.left,
			});
		}

		return raw;
	};

	return _decoder;
};

/**
 * Validate an incoming daemon→client WebSocket message using RelayMessageSchema.
 *
 * Known message types are decoded and returned with schema-validated fields.
 * Unknown messages pass through unchanged. Known messages with invalid
 * protocol shape reject with ProtocolDecodeError.
 *
 * The Schema module is lazy-loaded on first call for code-splitting.
 */
export const validateIncomingMessage = async (
	raw: unknown,
): Promise<unknown> => {
	const decode = await getDecoder();
	return decode(raw);
};

/**
 * Pre-load the schema decoder before opening the WebSocket. If the lazy chunk
 * fails to load, fall back to passthrough so the app keeps receiving messages.
 */
export const preloadDecoder = async (): Promise<void> => {
	try {
		await getDecoder();
	} catch (err) {
		console.warn(
			"[effect-boundary] Failed to load Schema decoder; using passthrough",
			err,
		);
		_decoder = passthroughDecoder;
	}
};

/**
 * Synchronous decode path for the WebSocket stream after preloadDecoder().
 * If preload has not happened, gracefully pass raw data through.
 */
export const decodeMessage = (raw: unknown): unknown =>
	_decoder ? _decoder(raw) : raw;

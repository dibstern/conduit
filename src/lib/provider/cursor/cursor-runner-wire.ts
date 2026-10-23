import { Schema } from "effect";
import type { RunnerWireCodec } from "../runner/runner-protocol.js";
import { CursorCredentialEnvelope } from "./cursor-credential.js";

const credentialJson = Schema.toCodecJson(CursorCredentialEnvelope);

/** Only this transport boundary unwraps the redacted key for the runner. */
export const cursorRunnerWire: RunnerWireCodec = {
	encode: (message) => {
		if (
			message.type !== "command" ||
			message.command.type !== "send-turn" ||
			!message.command.cursorCredential
		)
			return `${JSON.stringify(message)}\n`;
		return `${JSON.stringify({ ...message, command: { ...message.command, cursorCredential: Schema.encodeSync(credentialJson)(message.command.cursorCredential) } })}\n`;
	},
	decode: (message) => {
		if (
			message.type !== "command" ||
			message.command.type !== "send-turn" ||
			!message.command.cursorCredential
		)
			return message;
		return {
			...message,
			command: {
				...message.command,
				cursorCredential: Schema.decodeUnknownSync(credentialJson)(
					message.command.cursorCredential,
				),
			},
		};
	},
};

import { Effect, Schema } from "effect";
import type {
	ServerMarkInput,
	ServerMarkResult,
} from "../runner/runner-protocol.js";
import {
	DynamicToolCallParamsSchema,
	type DynamicToolCallResponseSchema,
} from "./app-server/protocol.js";

/**
 * 8.7 Declared, Codex's fallback when its sandbox blocks the CLI socket. CONTRACT.md 2992 names
 * "conduit's MCP tool"; nearest reading: an app-server dynamic tool, answered by the runner that
 * owns the app-server, so the caller is that runner's session (as a CLI's pid names its own).
 */
export const SERVER_MARK_TOOL = {
	type: "function",
	name: "conduit_server_mark",
	description:
		"Declare a server this session runs, as `conduit server mark <port> --serving|--awaited` does, when that command cannot reach Conduit. serving: a dev server left running for the user. awaited: a server this task is still waiting on.",
	inputSchema: {
		type: "object",
		properties: {
			port: { type: "integer", minimum: 1, maximum: 65535 },
			role: { type: "string", enum: ["serving", "awaited"] },
		},
		required: ["port", "role"],
		additionalProperties: false,
	},
} as const;

const ServerMarkCall = Schema.Struct({
	...DynamicToolCallParamsSchema.fields,
	arguments: Schema.Struct({
		port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
		role: Schema.Literals(["serving", "awaited"]),
	}),
});

const reply = (
	success: boolean,
	text: string,
): typeof DynamicToolCallResponseSchema.Type => ({
	contentItems: [{ type: "inputText", text }],
	success,
});

/** Answers an `item/tool/call` for the mark tool; undefined for any other tool. */
export const answerServerMark = (
	params: unknown,
	mark: (input: ServerMarkInput) => Effect.Effect<ServerMarkResult, unknown>,
) => {
	const call = Schema.decodeUnknownOption(DynamicToolCallParamsSchema)(params);
	if (call._tag === "None" || call.value.tool !== SERVER_MARK_TOOL.name)
		return undefined;
	const unavailable = reply(
		false,
		"Conduit's server is unavailable. Try marking the server again when it reconnects.",
	);
	return Schema.decodeUnknownEffect(ServerMarkCall)(params).pipe(
		Effect.matchEffect({
			onFailure: () =>
				Effect.succeed(
					reply(
						false,
						"Pass port (an integer from 1 to 65535) and role (serving or awaited).",
					),
				),
			onSuccess: ({ arguments: { port, role } }) =>
				mark({ port, role }).pipe(
					Effect.timeout("10 seconds"),
					Effect.map((result) =>
						result.ok
							? reply(true, `Marked port ${port} as ${role}`)
							: reply(false, result.reason),
					),
					Effect.orElseSucceed(() => unavailable),
				),
		}),
	);
};

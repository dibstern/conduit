import { Effect, Result as Either, Schema } from "effect";
import { createEventId } from "../../persistence/events.js";
import type { EventSink } from "../types.js";
import type { CursorTurnEvents } from "./cursor-turn-events.js";
import type { CursorCustomTool } from "./sdk-port.js";

const decodeQuestions = Schema.decodeUnknownEither(
	Schema.Struct({
		questions: Schema.NonEmptyArray(
			Schema.Struct({
				question: Schema.NonEmptyString,
				header: Schema.NonEmptyString,
				options: Schema.Array(
					Schema.Struct({
						label: Schema.NonEmptyString,
						description: Schema.String,
					}),
				),
				multiSelect: Schema.optional(Schema.Boolean),
				custom: Schema.optional(Schema.Boolean),
			}),
		),
	}),
);

const CANCELLED = "Question cancelled: turn interrupted";

/** SDK callbacks enter the turn's queue; the runner owns the durable wait. */
export function cursorAskUserTool(
	sink: EventSink,
	events: CursorTurnEvents,
	signal: AbortSignal,
	enqueue: (answer: Effect.Effect<void>) => void,
): CursorCustomTool {
	const calls = new Map<string, Promise<string>>();
	return {
		description:
			"Ask the user clarifying questions in Conduit. Use this for every clarifying question (askQuestion is unavailable) and wait for the answer before continuing. Supply questions with a header, question, options (label and description), and optional multiSelect/custom flags. The user can choose options or type a custom answer.",
		inputSchema: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							question: { type: "string", minLength: 1 },
							header: { type: "string", minLength: 1 },
							options: {
								type: "array",
								items: {
									type: "object",
									properties: {
										label: { type: "string", minLength: 1 },
										description: { type: "string" },
									},
									required: ["label", "description"],
								},
							},
							multiSelect: { type: "boolean" },
							custom: { type: "boolean" },
						},
						required: ["question", "header", "options"],
					},
				},
			},
			required: ["questions"],
		},
		execute(args, context) {
			if (signal.aborted) return Promise.resolve(CANCELLED);
			const decoded = decodeQuestions(args);
			if (Either.isLeft(decoded))
				return Promise.resolve(
					"Invalid ask_user arguments: supply nonempty questions with header, question and options.",
				);
			const callId = context.toolCallId ?? createEventId();
			const existing = calls.get(callId);
			if (existing) return existing;
			const answer = new Promise<string>((resolve) => {
				// cancel/close do not stop custom callbacks in SDK 1.0.37.
				const onAbort = () => resolve(CANCELLED);
				signal.addEventListener("abort", onAbort, { once: true });
				const aborted = Effect.async<string>((resume) => {
					const abort = () => resume(Effect.succeed(CANCELLED));
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
					return Effect.sync(() => signal.removeEventListener("abort", abort));
				});
				enqueue(
					Effect.suspend(() => {
						if (signal.aborted) return Effect.succeed(CANCELLED);
						const label = events.questionSource(callId);
						return sink
							.requestQuestion({
								requestId: callId,
								toolUseId: callId,
								questions: decoded.right.questions.map((question) => ({
									...question,
									multiSelect: question.multiSelect ?? false,
									custom: question.custom ?? true,
									header: label
										? `${label}: ${question.header}`
										: question.header,
									options: [...question.options],
								})),
							})
							.pipe(
								Effect.map((answers) => JSON.stringify(answers)),
								Effect.catch(() =>
									Effect.succeed("Question request failed or was cancelled."),
								),
								Effect.raceFirst(aborted),
							);
					}).pipe(
						Effect.tap((result) => Effect.sync(() => resolve(result))),
						Effect.asVoid,
						Effect.ensuring(
							Effect.sync(() => {
								resolve(CANCELLED);
								signal.removeEventListener("abort", onAbort);
							}),
						),
					),
				);
			});
			calls.set(callId, answer);
			return answer;
		},
	};
}

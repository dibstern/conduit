// Failure modes: invalid JSON or schema data escapes validation, SDK errors
// become defects, error result frames become summaries or hide login errors,
// text sources duplicate each other, or cancellation leaks a query.
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { expect } from "vitest";
import {
	type ClaudeOneShotQueryFactory,
	makeClaudeOneShot,
} from "../../../../src/lib/domain/daemon/Services/claude-one-shot.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";

const makeClient = (queryFactory: ClaudeOneShotQueryFactory) =>
	makeClaudeOneShot({
		configDir: configuredClaudeConfigDir("/tmp/conduit-one-shot-login"),
		cwd: "/tmp",
		systemPrompt: "Return the requested answer only.",
		queryFactory,
	});

const reply = async function* (messages: readonly unknown[]) {
	yield* messages;
};
const answerSchema = Schema.Struct({ answer: Schema.Number });

describe("Claude one-shot", () => {
	it.effect("decodes structured output through the caller's schema", () =>
		Effect.gen(function* () {
			const client = makeClient(() =>
				reply([{ type: "result", result: '{"answer":42}' }]),
			);
			expect(yield* client.ask("Answer in JSON", answerSchema, "opus")).toEqual(
				{
					answer: 42,
				},
			);
		}),
	);

	it.effect.each(["not JSON", '{"answer":"wrong type"}'])(
		"returns a typed Failure for invalid output: %s",
		(text) =>
			Effect.gen(function* () {
				const client = makeClient(() =>
					reply([{ type: "result", result: text }]),
				);
				const result = yield* Effect.either(
					client.ask("Answer in JSON", answerSchema, "opus"),
				);
				expect(result).toMatchObject({
					_tag: "Left",
					left: { _tag: "ClaudeOneShotFailure", reason: "schema" },
				});
			}),
	);

	it.effect.each(["throw", "stream"] as const)(
		"returns a typed Failure when the SDK fails during %s",
		(stage) =>
			Effect.gen(function* () {
				const cause = new Error("SDK unavailable");
				const client = makeClient(() => {
					if (stage === "throw") throw cause;
					return (async function* () {
						yield { type: "assistant", message: { content: "Partial" } };
						throw cause;
					})();
				});
				const result = yield* Effect.either(
					client.ask("Answer", Schema.String, "opus"),
				);
				expect(result).toMatchObject({
					_tag: "Left",
					left: { _tag: "ClaudeOneShotFailure", reason: "query", cause },
				});
			}),
	);

	it.effect.each([
		{
			subtype: "error_during_execution",
			is_error: true,
			errors: ["Claude not signed in", "Run /login"],
		},
		{
			subtype: "success",
			is_error: true,
			result: "Claude not signed in\nRun /login",
		},
	])(
		"preserves SDK error result text instead of partial output: $subtype",
		(result) =>
			Effect.gen(function* () {
				const client = makeClient(() =>
					reply([
						{
							type: "assistant",
							message: { content: [{ text: "An unfinished summary" }] },
						},
						{ type: "result", ...result },
					]),
				);
				const response = yield* Effect.either(
					client.ask("Answer", Schema.String, "sonnet"),
				);
				expect(response).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "ClaudeOneShotFailure",
						reason: "query",
						cause: expect.objectContaining({
							message: "Claude not signed in\nRun /login",
						}),
					},
				});
			}),
	);

	it.effect("prefers complete assistant text over result and stream text", () =>
		Effect.gen(function* () {
			const client = makeClient(() =>
				reply([
					{
						type: "stream_event",
						event: { type: "content_block_delta", delta: { text: "Partial" } },
					},
					{ type: "assistant", message: { content: [{ text: "Assistant" }] } },
					{ type: "result", result: "Result" },
				]),
			);
			expect(yield* client.ask("Answer", Schema.String, "opus")).toBe(
				"Assistant",
			);
		}),
	);

	it.effect(
		"rejects an empty reply instead of treating it as a valid string",
		() =>
			Effect.gen(function* () {
				const client = makeClient(() =>
					reply([{ type: "result", result: "  " }]),
				);
				expect(
					yield* Effect.either(client.ask("Answer", Schema.String, "opus")),
				).toMatchObject({
					_tag: "Left",
					left: { _tag: "ClaudeOneShotFailure", reason: "empty" },
				});
			}),
	);

	it.effect("aborts the SDK query when the caller interrupts it", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			let signal: AbortSignal | undefined;
			const client = makeClient((params) => {
				signal = params.options?.abortController?.signal;
				return (async function* () {
					Effect.runSync(Deferred.succeed(started, undefined));
					await new Promise<void>((resolve) =>
						signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
					yield { type: "result", result: "Cancelled" };
				})();
			});
			const fiber = yield* Effect.fork(
				client.ask("Answer", Schema.String, "opus"),
			);
			yield* Deferred.await(started);
			yield* Fiber.interrupt(fiber);
			expect(signal?.aborted).toBe(true);
		}),
	);
});

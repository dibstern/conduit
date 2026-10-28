// Failure modes: plaintext escapes in mixed answers, structured answers change,
// nonces repeat, another daemon can decrypt, or tampering discloses input errors.
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	isSealedSecretAnswer,
	SecretAnswers,
	SecretAnswersLive,
} from "../../../src/lib/domain/daemon/Services/secret-answers.js";

describe("daemon secret answers", () => {
	it.effect(
		"seals only secret entries and preserves string and array answers at delivery",
		() =>
			Effect.gen(function* () {
				const service = yield* SecretAnswers;
				const answers = {
					"0": "Safe",
					"1": "fixture-secret",
					"2": ["second-secret", "third-secret"],
				};
				const sealed = yield* service.seal(answers, ["1", "2"]);
				expect(sealed["0"]).toBe("Safe");
				expect(isSealedSecretAnswer(sealed["1"])).toBe(true);
				expect(isSealedSecretAnswer(sealed["2"])).toBe(true);
				for (const secret of [
					"fixture-secret",
					"second-secret",
					"third-secret",
				]) {
					expect(JSON.stringify(sealed)).not.toContain(secret);
				}
				expect(
					yield* service.unseal(JSON.parse(JSON.stringify(sealed))),
				).toEqual(answers);
				expect(answers["1"]).toBe("fixture-secret");
				const again = yield* service.seal(answers, ["1", "2"]);
				expect(again["1"]).not.toEqual(sealed["1"]);
			}).pipe(Effect.provide(SecretAnswersLive)),
	);

	it.effect("expires an undelivered answer when the daemon key changes", () =>
		Effect.gen(function* () {
			const previous = yield* SecretAnswers;
			const sealed = yield* previous.seal({ "0": "private-answer" }, ["0"]);
			const next = yield* Layer.build(Layer.fresh(SecretAnswersLive));
			const result = yield* Effect.result(
				SecretAnswers.use((service) => service.unseal(sealed)).pipe(
					Effect.provide(next),
				),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SecretAnswerFailure", code: "secret_answer_expired" },
			});
			expect(JSON.stringify(result)).not.toContain("private-answer");
		}).pipe(Effect.scoped, Effect.provide(SecretAnswersLive)),
	);

	it.effect("fails authentication with a safe typed error", () =>
		Effect.gen(function* () {
			const service = yield* SecretAnswers;
			const sealed = yield* service.seal({ "0": "tamper-secret" }, ["0"]);
			const envelope = sealed["0"];
			expect(isSealedSecretAnswer(envelope)).toBe(true);
			if (!isSealedSecretAnswer(envelope)) return;
			const result = yield* Effect.result(
				service.unseal({ "0": { ...envelope, ciphertext: "AAAA" } }),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SecretAnswerFailure", code: "secret_answer_expired" },
			});
			expect(JSON.stringify(result)).not.toContain("tamper-secret");
		}).pipe(Effect.provide(SecretAnswersLive)),
	);
});

import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { Context, Data, Effect, Layer } from "effect";
import { isRecord } from "../../../utils.js";

export class SecretAnswerFailure extends Data.TaggedError(
	"SecretAnswerFailure",
)<{
	readonly code: "secret_answer_expired" | "secret_answer_unavailable";
}> {
	get message(): string {
		return this.code === "secret_answer_expired"
			? "Secret answer expired after the server restarted. Please re-enter the answer."
			: "Secret answers require the daemon's durable sealing service.";
	}
}

interface SealedSecretAnswer {
	readonly _tag: "SealedSecretAnswer";
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

export const isSealedSecretAnswer = (
	value: unknown,
): value is SealedSecretAnswer =>
	isRecord(value) &&
	value["_tag"] === "SealedSecretAnswer" &&
	typeof value["keyId"] === "string" &&
	typeof value["iv"] === "string" &&
	typeof value["tag"] === "string" &&
	typeof value["ciphertext"] === "string";

export class SecretAnswers extends Context.Service<
	SecretAnswers,
	{
		readonly seal: (
			answers: Readonly<Record<string, unknown>>,
			secretIndices: readonly string[],
		) => Effect.Effect<Record<string, unknown>, SecretAnswerFailure>;
		readonly unseal: (
			answers: Readonly<Record<string, unknown>>,
		) => Effect.Effect<Record<string, unknown>, SecretAnswerFailure>;
	}
>()("SecretAnswers") {}

/** Construct once with the daemon. Neither the key nor plaintext enters a store. */
export const SecretAnswersLive = Layer.effect(
	SecretAnswers,
	Effect.gen(function* () {
		const { key, keyId } = yield* Effect.try({
			try: () => ({ key: randomBytes(32), keyId: randomUUID() }),
			catch: () =>
				new SecretAnswerFailure({ code: "secret_answer_unavailable" }),
		});
		return {
			seal: (answers, secretIndices) =>
				Effect.try({
					try: () =>
						Object.fromEntries(
							Object.entries(answers).map(([index, answer]) => {
								if (!secretIndices.includes(index)) return [index, answer];
								const iv = randomBytes(12);
								const cipher = createCipheriv("aes-256-gcm", key, iv, {
									authTagLength: 16,
								});
								cipher.setAAD(Buffer.from(keyId));
								const ciphertext = Buffer.concat([
									cipher.update(JSON.stringify(answer), "utf8"),
									cipher.final(),
								]);
								return [
									index,
									{
										_tag: "SealedSecretAnswer",
										keyId,
										iv: iv.toString("base64"),
										tag: cipher.getAuthTag().toString("base64"),
										ciphertext: ciphertext.toString("base64"),
									} satisfies SealedSecretAnswer,
								];
							}),
						),
					catch: () =>
						new SecretAnswerFailure({ code: "secret_answer_unavailable" }),
				}),
			unseal: (answers) =>
				Effect.try({
					try: () =>
						Object.fromEntries(
							Object.entries(answers).map(([index, answer]) => {
								if (!isSealedSecretAnswer(answer)) return [index, answer];
								if (answer.keyId !== keyId)
									throw new SecretAnswerFailure({
										code: "secret_answer_expired",
									});
								const decipher = createDecipheriv(
									"aes-256-gcm",
									key,
									Buffer.from(answer.iv, "base64"),
									{ authTagLength: 16 },
								);
								decipher.setAAD(Buffer.from(keyId));
								decipher.setAuthTag(Buffer.from(answer.tag, "base64"));
								const plaintext = Buffer.concat([
									decipher.update(Buffer.from(answer.ciphertext, "base64")),
									decipher.final(),
								]);
								const value: unknown = JSON.parse(plaintext.toString("utf8"));
								return [index, value];
							}),
						),
					catch: () =>
						new SecretAnswerFailure({ code: "secret_answer_expired" }),
				}),
		} satisfies SecretAnswers["Service"];
	}),
);

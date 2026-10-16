import { Effect } from "effect";
import { ProviderInstanceFailure } from "../errors.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import type { ProviderCapabilities } from "../types.js";
import { resolveCursorCredential } from "./cursor-credential.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import type { CursorSdkPort } from "./sdk-port.js";

let defaultPort: CursorSdkPort | undefined;

const discoveryFailure = (reason: string) =>
	new ProviderInstanceFailure({
		providerId: "cursor",
		operation: "discover",
		cause: new Error(reason),
	});

export const discoverCursorEffect = (
	port?: CursorSdkPort,
): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> =>
	Effect.gen(function* () {
		const sdk = yield* Effect.try({
			try: () => port ?? (defaultPort ??= createCursorSdkPort()),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		const runtime = yield* Effect.tryPromise({
			try: () => sdk.probeRuntime(),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		if (!runtime.available)
			return yield* Effect.fail(
				discoveryFailure(runtime.reason ?? "Cursor SDK could not load"),
			);
		const credential = yield* Effect.tryPromise({
			try: () => resolveCursorCredential(sdk),
			catch: () => discoveryFailure("Cursor credential lookup failed"),
		});
		if (!credential)
			return yield* Effect.fail(
				discoveryFailure(
					"Cursor has no credential; set CURSOR_API_KEY or log in with the Cursor SDK",
				),
			);
		const models = yield* Effect.tryPromise({
			try: () => sdk.modelsList(credential),
			catch: () => discoveryFailure("Cursor model list failed"),
		}).pipe(
			Effect.timeoutFail({
				duration: "15 seconds",
				onTimeout: () => discoveryFailure("Cursor model list failed"),
			}),
		);
		return {
			models: models.map((model) => ({
				id: model.id,
				name: model.displayName,
				providerId: "cursor",
			})),
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: false,
			supportsQuestions: true,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		};
	});

export const makeCursorRunnerDriver = (
	port?: CursorSdkPort,
): RunnerDriverPieces => ({
	driverKind: "cursor",
	discoverEffect: () => discoverCursorEffect(port),
	prepareTurnEffect: (input) =>
		Effect.succeed({
			input: {
				...input,
				instanceId: input.account?.id ?? input.instanceId ?? "cursor",
			},
		}),
});

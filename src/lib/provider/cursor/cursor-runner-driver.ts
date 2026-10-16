import { Effect, Schema } from "effect";
import type { Account } from "../../contracts/account.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { RunnerDriverPieces } from "../runner/runner-provider-instance.js";
import type { ModelInfo, ProviderCapabilities } from "../types.js";
import { resolveCursorCredential } from "./cursor-credential.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import { discoverCursorSkillsEffect } from "./cursor-skill-discovery.js";
import type { CursorModel, CursorSdkPort } from "./sdk-port.js";

export const CursorModelParameters = Schema.Array(
	Schema.Struct({ id: Schema.String, value: Schema.String }),
);

/** Picker keys describe combinations; the values retain Cursor's native ids. */
export function cursorModelInfo(model: CursorModel): ModelInfo {
	const sdkDefault = model.variants?.find(({ isDefault }) => isDefault);
	// Keep the SDK's default combination, with paid Fast off when it has a twin.
	const defaultVariant =
		model.variants?.find(
			({ params }) =>
				sdkDefault?.params.some(
					({ id, value }) => id === "fast" && value === "true",
				) &&
				params.length === sdkDefault.params.length &&
				params.every(({ id, value }) =>
					id === "fast"
						? value === "false"
						: sdkDefault.params.some(
								(parameter) => parameter.id === id && parameter.value === value,
							),
				),
		) ?? sdkDefault;
	const variants = model.variants
		?.filter(({ params }) => params.length > 0)
		.map((variant) => {
			const labels = variant.params.flatMap(({ id, value }) => {
				const parameter = model.parameters?.find((entry) => entry.id === id);
				const label = parameter?.values
					.find((entry) => entry.value === value)
					?.displayName?.replace(/[\u200b-\u200d\ufeff]/g, "")
					.trim();
				if (id === "fast") return value === "false" ? [] : [label || "Fast"];
				if (id === "thinking")
					return [value === "true" ? "Thinking" : "No thinking"];
				if (id === "effort" || id === "reasoning_effort" || id === "reasoning")
					return [value];
				return [label || `${parameter?.displayName ?? id}: ${value}`];
			});
			return { key: labels.join(" · ") || "Standard", variant };
		})
		.sort((left, right) => {
			// Keep each captured parameter order, with standard before paid Fast.
			if (left.key === "Standard") return -1;
			if (right.key === "Standard") return 1;
			return 0;
		});
	return {
		id: model.id,
		name: model.displayName,
		providerId: "cursor",
		...(variants?.length
			? {
					variants: Object.fromEntries(
						variants.map(({ key, variant }) => [
							key,
							{
								params: variant.params.map(({ id, value }) => ({ id, value })),
								...(variant === defaultVariant ? { isDefault: true } : {}),
							},
						]),
					),
				}
			: {}),
	};
}

const discoveryFailure = (reason: string, operation = "discover") =>
	new ProviderInstanceFailure({
		providerId: "cursor",
		operation,
		cause: new Error(reason),
	});

let defaultPort: CursorSdkPort | undefined;
const catalogs = new WeakMap<
	CursorSdkPort,
	{
		lock: ReturnType<typeof Effect.unsafeMakeSemaphore>;
		entries: Map<
			string,
			{
				expiresAt: number;
				models: readonly ModelInfo[];
			}
		>;
	}
>();
export const discoverCursorEffect = (
	port?: CursorSdkPort,
	account?: Account,
	workspaceRoot?: string,
): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> =>
	Effect.gen(function* () {
		const adapter = yield* Effect.try({
			try: () => port ?? (defaultPort ??= createCursorSdkPort()),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		const runtime = yield* Effect.tryPromise({
			try: () => adapter.probeRuntime(),
			catch: () => discoveryFailure("Cursor SDK could not load"),
		});
		if (!runtime.available)
			return yield* Effect.fail(
				discoveryFailure(runtime.reason ?? "Cursor SDK could not load"),
			);
		const credential = yield* Effect.tryPromise({
			try: () =>
				resolveCursorCredential(adapter, { ...process.env, ...account?.env }),
			catch: () => discoveryFailure("Cursor credential lookup failed"),
		});
		if (!credential)
			return yield* Effect.fail(
				discoveryFailure(
					"Cursor has no credential; set CURSOR_API_KEY or log in with the Cursor SDK",
					"discover.auth-required",
				),
			);
		// Keyed by credential, so a login or logout reads a fresh catalog.
		const key = JSON.stringify([
			account?.id ?? "cursor",
			credential.fingerprint,
		]);
		let catalog = catalogs.get(adapter);
		if (!catalog) {
			catalog = { entries: new Map(), lock: Effect.unsafeMakeSemaphore(1) };
			catalogs.set(adapter, catalog);
		}
		const { entries: cache, lock } = catalog;
		const models = yield* lock.withPermits(1)(
			Effect.gen(function* () {
				const cached = cache.get(key);
				if (cached && cached.expiresAt > Date.now()) return cached.models;
				cache.delete(key);
				const listed = yield* Effect.tryPromise({
					try: () => adapter.modelsList(credential),
					catch: () => discoveryFailure("Cursor model list failed"),
				}).pipe(
					Effect.timeoutFail({
						duration: "15 seconds",
						onTimeout: () => discoveryFailure("Cursor model list failed"),
					}),
				);
				if (listed.length === 0)
					return yield* Effect.fail(
						discoveryFailure("Cursor model list is empty"),
					);
				const models = listed.map(cursorModelInfo);
				const ttlOverride =
					process.env["NODE_ENV"] === "test"
						? Number(process.env["CONDUIT_TEST_CURSOR_CATALOG_TTL_MS"])
						: Number.NaN;
				const ttlMs =
					Number.isFinite(ttlOverride) && ttlOverride > 0
						? ttlOverride
						: 30 * 60_000;
				cache.set(key, { expiresAt: Date.now() + ttlMs, models });
				return models;
			}),
		);
		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: false,
			supportsQuestions: true,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: workspaceRoot
				? yield* discoverCursorSkillsEffect(workspaceRoot)
				: [],
		};
	});

export const makeCursorRunnerDriver = (
	workspaceRoot: string,
	port?: CursorSdkPort,
): RunnerDriverPieces => ({
	driverKind: "cursor",
	discoverEffect: (directory, account) =>
		discoverCursorEffect(port, account, directory ?? workspaceRoot),
	prepareTurnEffect: (input) =>
		Effect.gen(function* () {
			const catalog = yield* discoverCursorEffect(port, input.account).pipe(
				Effect.catchAll((failure) =>
					// The runner owns the auth error and its durable turn terminal.
					failure.operation === "discover.auth-required"
						? Effect.succeed({ models: [] })
						: Effect.fail(failure),
				),
			);
			const model = catalog.models.find(
				({ id }) => id === input.model?.modelId,
			);
			const variants = model?.variants ?? {};
			const selected = input.variant ? variants[input.variant] : undefined;
			if (model && input.variant && !selected)
				return yield* Effect.fail(
					discoveryFailure("Cursor model parameter choice is not offered"),
				);
			const variant =
				selected ??
				Object.values(variants).find(
					(variant) => variant["isDefault"] === true,
				);
			const params = variant?.["params"] ?? [];
			return {
				input: {
					...input,
					instanceId: input.account?.id ?? input.instanceId ?? "cursor",
					providerState: {
						...input.providerState,
						"cursor.modelParams": params,
					},
				},
			};
		}),
});

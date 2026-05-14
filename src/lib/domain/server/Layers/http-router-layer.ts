import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
	NodeFileSystem,
	NodeHttpServer,
	NodePath,
} from "@effect/platform-node";
import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import type { AuthManager } from "../../../auth.js";
import {
	CaCertProvider,
	effectRouterWithCors,
	HealthProvider,
	ProjectApiDelegateProvider,
	ProjectsProvider,
	PushProvider,
	RemoveProjectProvider,
	type RouterProjectInfo,
	SetupInfoProvider,
	ThemeProvider,
} from "../../../server/effect-http-router.js";
import type { PushSubscriptionData } from "../../../server/push.js";
import { loadThemeFiles } from "../../../server/theme-loader.js";
import type { ThemesResponse } from "../../../shared-types.js";
import { TlsCertTag } from "../../daemon/Layers/tls-cert-layer.js";
import {
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../daemon/Services/daemon-config-ref.js";
import { DaemonHandleTag } from "../../daemon/Services/daemon-handle.js";
import {
	ProjectRegistryTag,
	type ProjectState,
} from "../../daemon/Services/project-registry-service.js";
import {
	type RelayCache,
	RelayCacheTag,
} from "../../daemon/Services/relay-cache.js";
import { PushManagerTag } from "../Services/push-service.js";
import { StaticDirTag } from "../Services/static-file-handler.js";
import {
	type AuthManagerService,
	AuthManagerTag,
	makeAuthManagerLive,
} from "./auth-middleware.js";

export type { RouterProjectInfo };

export interface DaemonHttpRequestHandler {
	readonly handleRequest: (
		req: IncomingMessage,
		res: ServerResponse,
	) => Promise<void>;
}

export class DaemonHttpRequestHandlerTag extends Context.Tag(
	"DaemonHttpRequestHandler",
)<DaemonHttpRequestHandlerTag, DaemonHttpRequestHandler>() {}

export interface DaemonHttpRouterPushManager {
	readonly getPublicKey: () => string | null | undefined;
	readonly addSubscription: (
		endpoint: string,
		subscription: PushSubscriptionData,
	) => void;
	readonly removeSubscription: (endpoint: string) => void;
}

export interface StandaloneHttpRouterOptions {
	readonly auth: AuthManager;
	readonly staticDir: string;
	readonly getProjects: () => RouterProjectInfo[];
	readonly removeProject: (slug: string) => boolean;
	readonly delegateApiRequest?: (
		slug: string,
		subPath: string,
		req: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
	readonly getPort: () => number;
	readonly getIsTls: () => boolean;
	readonly loadThemes: () => Promise<ThemesResponse>;
	readonly pushManager?: DaemonHttpRouterPushManager | null | undefined;
	readonly caRootPath?: string | undefined;
	readonly caCertDer?: Buffer | undefined;
}

interface HttpRouterRequestHandlerOptions {
	readonly authLayer: Layer.Layer<AuthManagerTag>;
	readonly setupInfoLayer: Layer.Layer<SetupInfoProvider>;
	readonly staticDir: string;
	readonly getProjects: () => Effect.Effect<RouterProjectInfo[]>;
	readonly removeProject?: (slug: string) => Effect.Effect<void, unknown>;
	readonly delegateApiRequest?: (
		slug: string,
		subPath: string,
		req: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
	readonly getHealthResponse?: () => Effect.Effect<object>;
	readonly loadThemes: () => Effect.Effect<ThemesResponse, unknown>;
	readonly pushManager?: DaemonHttpRouterPushManager | null | undefined;
	readonly caRootPath?: string | undefined;
	readonly caCertDer?: Buffer | undefined;
}

const buildHttpRouterRequestHandler = (
	options: HttpRouterRequestHandlerOptions,
): DaemonHttpRequestHandler => {
	let routerLayer = Layer.mergeAll(
		options.authLayer,
		Layer.succeed(StaticDirTag, options.staticDir),
		Layer.succeed(ProjectsProvider, { getProjects: options.getProjects }),
		options.setupInfoLayer,
		Layer.succeed(ThemeProvider, { loadThemes: options.loadThemes }),
		NodeFileSystem.layer,
		NodePath.layer,
	);

	if (options.removeProject != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(RemoveProjectProvider, {
				removeProject: options.removeProject,
			}),
		);
	}

	if (options.delegateApiRequest != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(ProjectApiDelegateProvider, {
				delegateApiRequest: options.delegateApiRequest,
			}),
		);
	}

	if (options.getHealthResponse != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(HealthProvider, {
				getHealthResponse: options.getHealthResponse,
			}),
		);
	}

	if (options.pushManager != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(PushProvider, {
				getPublicKey: () => options.pushManager?.getPublicKey() ?? undefined,
				addSubscription: (endpoint, subscription) =>
					options.pushManager?.addSubscription(
						endpoint,
						subscription as PushSubscriptionData,
					),
				removeSubscription: (endpoint) =>
					options.pushManager?.removeSubscription(endpoint),
			}),
		);
	}

	if (options.caRootPath != null || options.caCertDer != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(CaCertProvider, {
				caCertDer: options.caCertDer,
				caRootPath: options.caRootPath,
			}),
		);
	}

	const effectHandler = Effect.runSync(
		NodeHttpServer.makeHandler(
			effectRouterWithCors.pipe(Effect.provide(routerLayer)),
		),
	);

	return {
		handleRequest: async (req, res) => {
			effectHandler(req, res);
		},
	};
};

const routerStatusForProjectState = (
	entry: ProjectState,
): NonNullable<RouterProjectInfo["status"]> => {
	switch (entry._tag) {
		case "Ready":
			return "ready";
		case "Error":
			return "error";
		case "Registering":
			return "registering";
	}
};

const makeDaemonProjectsReader = (deps: {
	readonly configRef: Ref.Ref<DaemonRuntimeConfig>;
	readonly projectRegistry: Ref.Ref<HashMap.HashMap<string, ProjectState>>;
	readonly relayCache: RelayCache;
}) => {
	const { configRef, projectRegistry, relayCache } = deps;
	return () =>
		Effect.gen(function* () {
			const config = yield* Ref.get(configRef);
			const state = yield* Ref.get(projectRegistry);
			const entries = Array.from(HashMap.entries(state)).sort(
				([, a], [, b]) => (b.project.lastUsed ?? 0) - (a.project.lastUsed ?? 0),
			);

			return yield* Effect.forEach(entries, ([slug, entry]) =>
				Effect.gen(function* () {
					const cachedRelay = yield* relayCache.peek(slug);
					const relayStatus = Option.isSome(cachedRelay)
						? cachedRelay.value.getStatusSnapshot?.()
						: undefined;
					const sessions =
						relayStatus?.sessionCount ||
						config.persistedSessionCounts.get(slug) ||
						0;
					return {
						slug,
						directory: entry.project.directory,
						title: entry.project.title,
						status: routerStatusForProjectState(entry),
						...(entry._tag === "Error" && { error: entry.error }),
						clients: relayStatus?.clients ?? 0,
						sessions,
						isProcessing: relayStatus?.isProcessing ?? false,
					} satisfies RouterProjectInfo;
				}),
			);
		});
};

export const makeStandaloneHttpRouterRequestHandler = (
	options: StandaloneHttpRouterOptions,
): DaemonHttpRequestHandler =>
	buildHttpRouterRequestHandler({
		authLayer: makeAuthManagerLive(options.auth),
		setupInfoLayer: Layer.succeed(SetupInfoProvider, {
			getPort: () => Effect.sync(options.getPort),
			getIsTls: () => Effect.sync(options.getIsTls),
		}),
		staticDir: options.staticDir,
		getProjects: () => Effect.sync(options.getProjects),
		removeProject: (slug) =>
			options.removeProject(slug)
				? Effect.void
				: Effect.fail(new Error("Project not found")),
		delegateApiRequest:
			options.delegateApiRequest ??
			(() => Effect.fail(new Error("Project API route not found"))),
		loadThemes: () =>
			Effect.tryPromise({
				try: options.loadThemes,
				catch: (cause) => cause,
			}),
		pushManager: options.pushManager,
		caRootPath: options.caRootPath,
		caCertDer: options.caCertDer,
	});

export const makeDaemonHttpRouterLive = (staticDir: string) =>
	Layer.effect(
		DaemonHttpRequestHandlerTag,
		Effect.gen(function* () {
			const auth: AuthManagerService = yield* AuthManagerTag;
			const configRef = yield* DaemonConfigRefTag;
			const daemonHandle = yield* DaemonHandleTag;
			const tls = yield* TlsCertTag;
			const projectRegistry = yield* ProjectRegistryTag;
			const relayCache = yield* RelayCacheTag;
			const pushManager = yield* PushManagerTag;
			const legacyPushManager = yield* pushManager.getLegacyManager;
			return buildHttpRouterRequestHandler({
				authLayer: Layer.succeed(AuthManagerTag, auth),
				setupInfoLayer: Layer.succeed(SetupInfoProvider, {
					getPort: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.port)),
					getIsTls: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.tlsEnabled)),
				}),
				staticDir,
				getProjects: makeDaemonProjectsReader({
					configRef,
					projectRegistry,
					relayCache,
				}),
				removeProject: (slug: string) => daemonHandle.removeProject(slug),
				getHealthResponse: () => daemonHandle.getStatus(),
				loadThemes: () =>
					Effect.tryPromise({
						try: loadThemeFiles,
						catch: (cause) => cause,
					}),
				pushManager: Option.getOrUndefined(legacyPushManager),
				caRootPath: tls.caRootPath ?? undefined,
				caCertDer: tls.caCertDer ?? undefined,
			});
		}),
	);

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
	NodeFileSystem,
	NodeHttpServer,
	NodePath,
} from "@effect/platform-node";
import { Context, Effect, Layer, Ref } from "effect";
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
import type { ThemesResponse } from "../../../shared-types.js";
import { DaemonConfigRefTag } from "../../daemon/Services/daemon-config-ref.js";
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

export interface DaemonHttpRouterOptions {
	readonly staticDir: string;
	readonly getProjects: () => RouterProjectInfo[];
	readonly removeProject: (slug: string) => Promise<unknown>;
	readonly getHealthResponse: () => object;
	readonly loadThemes: () => Promise<ThemesResponse>;
	readonly pushManager?: DaemonHttpRouterPushManager | null | undefined;
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
	readonly getProjects: () => RouterProjectInfo[];
	readonly removeProject?: (slug: string) => Effect.Effect<void, unknown>;
	readonly delegateApiRequest?: (
		slug: string,
		subPath: string,
		req: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
	readonly getHealthResponse?: () => object;
	readonly loadThemes: () => Promise<ThemesResponse>;
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
		getProjects: options.getProjects,
		removeProject: (slug) =>
			options.removeProject(slug)
				? Effect.void
				: Effect.fail(new Error("Project not found")),
		delegateApiRequest:
			options.delegateApiRequest ??
			(() => Effect.fail(new Error("Project API route not found"))),
		loadThemes: options.loadThemes,
		pushManager: options.pushManager,
		caRootPath: options.caRootPath,
		caCertDer: options.caCertDer,
	});

export const makeDaemonHttpRouterLive = (options: DaemonHttpRouterOptions) =>
	Layer.effect(
		DaemonHttpRequestHandlerTag,
		Effect.gen(function* () {
			const auth: AuthManagerService = yield* AuthManagerTag;
			const configRef = yield* DaemonConfigRefTag;
			return buildHttpRouterRequestHandler({
				authLayer: Layer.succeed(AuthManagerTag, auth),
				setupInfoLayer: Layer.succeed(SetupInfoProvider, {
					getPort: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.port)),
					getIsTls: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.tlsEnabled)),
				}),
				staticDir: options.staticDir,
				getProjects: options.getProjects,
				removeProject: (slug: string) =>
					Effect.tryPromise(() => options.removeProject(slug)).pipe(
						Effect.asVoid,
					),
				getHealthResponse: options.getHealthResponse,
				loadThemes: options.loadThemes,
				pushManager: options.pushManager,
			});
		}),
	);

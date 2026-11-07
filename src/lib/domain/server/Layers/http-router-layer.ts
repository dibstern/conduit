import type { IncomingMessage, ServerResponse } from "node:http";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, HashMap, Layer, Option, Ref, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { SCRATCH_PROJECT_SLUG } from "../../../contracts/scratch-project.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	AttachmentsProvider,
	CaCertProvider,
	effectRouterWithOriginCheck,
	HealthProvider,
	type HttpAttachmentReader,
	ProjectsProvider,
	PushProvider,
	type RouterProjectInfo,
	SetupInfoProvider,
} from "../../../server/effect-http-router.js";
import type { PushSubscriptionData } from "../../../server/push.js";
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
import { ProjectServices } from "../../daemon/Services/project-services.js";
import { AttachmentStoreTag } from "../../persistence/Services/attachment-store.js";
import { ProjectSettingsTag } from "../../relay/Services/project-settings.js";
import { RelayStatusSnapshotTag } from "../../relay/Services/relay-status-snapshot.js";
import { StatusPollerCoreTag } from "../../relay/Services/session-status-poller.js";
import { PushManagerTag } from "../Services/push-service.js";
import { StaticDirTag } from "../Services/static-file-handler.js";
import { type AuthManagerService, AuthManagerTag } from "./auth-middleware.js";

export type { RouterProjectInfo };

export interface DaemonHttpRequestHandler {
	readonly handleRequest: (
		req: IncomingMessage,
		res: ServerResponse,
	) => Promise<void>;
}

export class DaemonHttpRequestHandlerTag extends Context.Service<
	DaemonHttpRequestHandlerTag,
	DaemonHttpRequestHandler
>()("DaemonHttpRequestHandler") {}

export interface DaemonHttpRouterPushManager {
	readonly getPublicKey: () => string | null | undefined;
	readonly addSubscription: (
		endpoint: string,
		subscription: PushSubscriptionData,
	) => void;
	readonly removeSubscription: (endpoint: string) => void;
}

interface HttpRouterRequestHandlerOptions {
	readonly authLayer: Layer.Layer<AuthManagerTag>;
	readonly setupInfoLayer: Layer.Layer<SetupInfoProvider>;
	readonly staticDir: string;
	readonly getProjects: () => Effect.Effect<RouterProjectInfo[]>;
	readonly readAttachment?: HttpAttachmentReader | undefined;
	readonly getHealthResponse?: () => Effect.Effect<object>;
	readonly pushManager?: DaemonHttpRouterPushManager | null | undefined;
	readonly caRootPath?: string | undefined;
	readonly caCertDer?: Buffer | undefined;
}

const makeHttpRouterLayer = (options: HttpRouterRequestHandlerOptions) => {
	let routerLayer = Layer.mergeAll(
		options.authLayer,
		Layer.succeed(StaticDirTag, options.staticDir),
		Layer.succeed(ProjectsProvider, { getProjects: options.getProjects }),
		options.setupInfoLayer,
		NodeFileSystem.layer,
		NodePath.layer,
	);
	if (options.readAttachment != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(AttachmentsProvider, { read: options.readAttachment }),
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

	return routerLayer;
};

const buildHttpRouterRequestHandlerEffect = (
	options: HttpRouterRequestHandlerOptions,
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const router = yield* HttpRouter.toHttpEffect(effectRouterWithOriginCheck);
		const effectHandler = yield* NodeHttpServer.makeHandler(router, { scope });
		return {
			handleRequest: async (req, res) => {
				effectHandler(req, res);
			},
		} satisfies DaemonHttpRequestHandler;
	}).pipe(Effect.provide(makeHttpRouterLayer(options)));

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
	readonly projects: ProjectServices["Service"];
	readonly statusPoller: Option.Option<StatusPollerCoreTag["Service"]>;
}) => {
	const { configRef, projectRegistry, projects, statusPoller } = deps;
	return () =>
		Effect.gen(function* () {
			const config = yield* Ref.get(configRef);
			const state = yield* Ref.get(projectRegistry);
			const entries = Array.from(HashMap.entries(state))
				.filter(([slug]) => slug !== SCRATCH_PROJECT_SLUG)
				.sort(
					([, a], [, b]) =>
						(b.project.lastUsed ?? 0) - (a.project.lastUsed ?? 0),
				);

			return yield* Effect.forEach(entries, ([slug, entry]) =>
				Effect.gen(function* () {
					// An unopened project reads its persisted count and stays closed.
					const opened = Option.getOrUndefined(yield* projects.opened(slug));
					const snapshot =
						opened && Context.get(opened, RelayStatusSnapshotTag).getSnapshot();
					const sessions =
						snapshot?.sessionCount ||
						config.persistedSessionCounts.get(slug) ||
						0;
					return {
						slug,
						folders: entry.project.folders,
						title: entry.project.title,
						status: routerStatusForProjectState(entry),
						...(entry._tag === "Error" && { error: entry.error }),
						clients: opened
							? Context.get(opened, ProjectSettingsTag).browsers.count()
							: 0,
						sessions,
						// The daemon's poller answers for a project no tab has opened too.
						isProcessing: Option.isSome(statusPoller)
							? yield* statusPoller.value.isProcessing(slug)
							: (snapshot?.isProcessing ?? false),
					} satisfies RouterProjectInfo;
				}),
			);
		});
};

export const makeDaemonHttpRouterLive = (staticDir: string) =>
	Layer.effect(
		DaemonHttpRequestHandlerTag,
		Effect.gen(function* () {
			const auth: AuthManagerService = yield* AuthManagerTag;
			const store = yield* Effect.serviceOption(PersistenceStore);
			const attachments = Option.isSome(store)
				? Context.get(store.value, AttachmentStoreTag)
				: undefined;
			const configRef = yield* DaemonConfigRefTag;
			const daemonHandle = yield* DaemonHandleTag;
			const tls = yield* TlsCertTag;
			const projectRegistry = yield* ProjectRegistryTag;
			const projects = yield* ProjectServices;
			const statusPoller = yield* Effect.serviceOption(StatusPollerCoreTag);
			const pushManager = yield* PushManagerTag;
			const legacyPushManager = yield* pushManager.getLegacyManager;
			return yield* buildHttpRouterRequestHandlerEffect({
				authLayer: Layer.succeed(AuthManagerTag, auth),
				setupInfoLayer: Layer.succeed(SetupInfoProvider, {
					getPort: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.port)),
					getIsTls: () =>
						Ref.get(configRef).pipe(Effect.map((config) => config.tlsEnabled)),
					getPublicUrl: () =>
						Ref.get(configRef).pipe(
							Effect.map(({ tailscaleServe }) =>
								tailscaleServe && "url" in tailscaleServe
									? tailscaleServe.url
									: null,
							),
						),
				}),
				staticDir,
				readAttachment: attachments
					? (_slug, hash) => attachments.get(hash)
					: undefined,
				getProjects: makeDaemonProjectsReader({
					configRef,
					projectRegistry,
					projects,
					statusPoller,
				}),
				getHealthResponse: () => daemonHandle.getStatus(),
				pushManager: Option.getOrUndefined(legacyPushManager),
				caRootPath: tls.caRootPath ?? undefined,
				caCertDer: tls.caCertDer ?? undefined,
			});
		}),
	);

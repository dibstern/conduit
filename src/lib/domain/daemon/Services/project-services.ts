import {
	Context,
	Data,
	Effect,
	HashMap,
	Option,
	PubSub,
	Queue,
	Ref,
} from "effect";
import type {
	PersistenceProjectContext,
	PersistenceStoreContext,
} from "../../../persistence/effect/live.js";
import { daemonStorePath } from "../../../persistence/project-storage.js";
import type { ClaudeSdkSeam, StoredProject } from "../../../types.js";
import type { AgentServiceTag } from "../../relay/Services/agent-service.js";
import type { AlertLedgerTag } from "../../relay/Services/alert-ledger.js";
import type { ContinuationTag } from "../../relay/Services/continuation.js";
import type { DirectoryListingServiceTag } from "../../relay/Services/directory-listing-service.js";
import type {
	OpenCodeHistoryReconcileTag,
	OpenCodeProcessLinkTag,
	OpenCodeRuntimeIngressTag,
	OpenCodeSessionCreationGateTag,
} from "../../relay/Services/opencode-runtime-ingress-service.js";
import type { PendingInteractionServiceTag } from "../../relay/Services/pending-interaction-service.js";
import type { ProjectSettingsTag } from "../../relay/Services/project-settings.js";
import type { ProviderRuntimeIngestionTag } from "../../relay/Services/provider-runtime-ingestion-service.js";
import type { ProviderTurnServiceTag } from "../../relay/Services/provider-turn-service.js";
import type { RelayStatusSnapshotTag } from "../../relay/Services/relay-status-snapshot.js";
import type {
	AgentLivenessTag,
	ConfigTag,
	ConnectPtyUpstreamTag,
	OpenCodeFileServiceTag,
	OpenCodeModelServiceTag,
	OpenCodeSettingsServiceTag,
	PtyManagerTag,
	TranslatorTag,
} from "../../relay/Services/services.js";
import type { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import type { SessionInboxTag } from "../../relay/Services/session-inbox.js";
import type {
	ProjectSessionManagerParts,
	SessionManagerServiceTag,
} from "../../relay/Services/session-manager-service.js";
import type { SessionTitleServiceTag } from "../../relay/Services/session-title-service.js";
import type { SessionWorkspaceHintStateTag } from "../../relay/Services/session-workspace-hint-state.js";
import type { OpenCodeTerminalServiceTag } from "../../relay/Services/terminal-service.js";
import type { ToolContentServiceTag } from "../../relay/Services/tool-content-service.js";
import type { ProjectShellEnvTag } from "../Layers/project-shell-env-layer.js";
import type { PollerTimings } from "../Layers/relay-factory-layer.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { DaemonEvent, type DaemonEventBusTag } from "./daemon-pubsub.js";
import {
	getEffectiveWorktreeCleanup,
	ProjectRegistryTag,
} from "./project-registry-service.js";
import type { WorktreeCleanupRequest } from "./worktree-cleanup-service.js";

/** What one generation of a project owns: dropped when its owner scope closes. */
export type ProjectGenerationParts =
	| RelayStatusSnapshotTag
	| OpenCodeSessionCreationGateTag
	| OpenCodeModelServiceTag
	| PersistenceProjectContext
	| PersistenceStoreContext
	// The ingestion side (82tn.16 slice 4).
	| PendingInteractionServiceTag
	| AlertLedgerTag
	| ProviderRuntimeIngestionTag
	| ContinuationTag
	| TranslatorTag
	| OpenCodeRuntimeIngressTag
	| OpenCodeHistoryReconcileTag
	| OpenCodeProcessLinkTag
	// Settings and titles (82tn.16 slice 5).
	| ProjectSettingsTag
	| SessionTitleServiceTag
	// Stateless readers (82tn.16 slice 7).
	| ToolContentServiceTag
	| DirectoryListingServiceTag
	| AgentLivenessTag
	// Turns and the inbox drain, and the agent service a continuation reads (lane 16o).
	| AgentServiceTag
	| ProviderTurnServiceTag
	| SessionInboxTag
	// Terminals (lane 16o).
	| OpenCodeTerminalServiceTag
	| PtyManagerTag
	| ConnectPtyUpstreamTag
	// OpenCode file and catalog readers (lane 16o).
	| OpenCodeFileServiceTag
	| OpenCodeSettingsServiceTag;

/** Everything a call naming the project runs with, built by the daemon. */
export type ProjectParts =
	| Exclude<ProjectSessionManagerParts, SessionManagerServiceTag>
	| ProjectGenerationParts
	| SessionEventBusTag
	| SessionWorkspaceHintStateTag;

export class ProjectServicesError extends Data.TaggedError(
	"ProjectServicesError",
)<{ readonly projectId: string; readonly reason: string }> {
	override get message(): string {
		return this.reason;
	}
}

/** Each project's context, built from the registry on request (82tn.16); no relay lends it. */
export class ProjectServices extends Context.Service<
	ProjectServices,
	{
		readonly forProject: (
			projectId: string,
		) => Effect.Effect<Context.Context<ProjectParts>, ProjectServicesError>;
		/** The parts one generation owns, shared with the project's relay. */
		readonly generation: (
			projectId: string,
		) => Effect.Effect<
			Context.Context<ProjectGenerationParts>,
			ProjectServicesError
		>;
	}
>()("ProjectServices") {}

/** The daemon's view of one registered project, as its calls (and its relay) read it. */
export const projectConfig = (
	project: Pick<StoredProject, "slug" | "folders">,
	daemon: {
		readonly configDir: string;
		readonly claudeSdk?: ClaudeSdkSeam | undefined;
		readonly pollerTimings?: PollerTimings | undefined;
		readonly environments?: ProjectShellEnvTag["Service"] | undefined;
		readonly cleanupQueue: Option.Option<Queue.Queue<WorktreeCleanupRequest>>;
		readonly registry: ProjectRegistryTag["Service"];
		readonly configRef: DaemonConfigRefTag["Service"];
		readonly eventBus: DaemonEventBusTag["Service"];
	},
): ConfigTag["Service"] => {
	const { slug } = project;
	const { environments, cleanupQueue } = daemon;
	// Read from the registry at each use, so a service built once per project sees
	// a folder change, as t3code reads the cwd at each turn start
	// (apps/server/src/orchestration-v2/Orchestrator.ts:1910). A removed project
	// keeps the folders it had.
	const folders = () =>
		Option.match(HashMap.get(Ref.getUnsafe(daemon.registry), slug), {
			onNone: () => project.folders,
			onSome: (entry) => entry.project.folders,
		});
	return {
		get projectDir() {
			return folders()[0];
		},
		get extraFolders() {
			return folders().slice(1);
		},
		slug,
		configDir: daemon.configDir,
		persistenceDbPath: daemonStorePath(daemon.configDir),
		...(environments && {
			shellEnv: (directory: string) =>
				environments.getSnapshot(directory, slug),
			prepareShellEnv: (directory: string) =>
				environments.waitUntilReady(directory, slug),
		}),
		...(daemon.claudeSdk && { claudeSdk: daemon.claudeSdk }),
		...daemon.pollerTimings,
		requestWorktreeCleanup: () =>
			Option.isSome(cleanupQueue)
				? Queue.offer(cleanupQueue.value, { projectSlug: slug }).pipe(
						Effect.asVoid,
					)
				: Effect.void,
		getWorktreeCleanup: () =>
			getEffectiveWorktreeCleanup(slug).pipe(
				Effect.provideService(ProjectRegistryTag, daemon.registry),
				Effect.provideService(DaemonConfigRefTag, daemon.configRef),
				Effect.orElseSucceed(() => "off" as const),
			),
		publishGlobalSetting: (tag) =>
			PubSub.publish(
				daemon.eventBus,
				DaemonEvent.GlobalSettingChanged({ originSlug: slug, tag }),
			).pipe(Effect.asVoid),
	};
};

import { Clock, Effect, Option } from "effect";
import { ProjectSaveRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import { DirectoryListingServiceTag } from "../../domain/relay/Services/directory-listing-service.js";
import { ConfigTag, LoggerTag } from "../../domain/relay/Services/services.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/session-workspace.js";
import { ToolContentServiceTag } from "../../domain/relay/Services/tool-content-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { formatErrorDetail } from "../../errors.js";
import {
	FILE_TREE_TIMEOUT_MS,
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../../handlers/files.js";
import { getDiscoveredSkillForSession } from "../../handlers/settings.js";
import { getSkillContentValue } from "../../handlers/skill-content.js";
import { labelProjectFolders } from "../../project-folders.js";
import { guardWorkspacePath } from "../../session/session-workspace.js";
import {
	mapRpcFailure,
	resolveSessionRequestDirectory,
	type WsRpcHandlerMap,
} from "./shared.js";

const resolveFileDirectory = (request: {
	readonly sessionId?: string | undefined;
	readonly root?: string | undefined;
	readonly path?: string | undefined;
}) =>
	Effect.gen(function* () {
		const directory = yield* resolveSessionRequestDirectory(request, "file");
		yield* guardWorkspacePath(directory, request.path);
		return directory;
	});

export const filesHandlers = {
	FindFolders: (request) =>
		Effect.gen(function* () {
			const directoryListing = yield* DirectoryListingServiceTag;
			return yield* directoryListing.find(request.query);
		}).pipe(
			Failure.mapEffectFailures((error) =>
				error instanceof ProjectSaveRejected
					? error
					: new WsRpcError({
							message: `FindFolders failed: ${formatErrorDetail(error)}`,
						}),
			),
		),
	GetFileTree: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			Effect.gen(function* () {
				const startedAt = yield* Clock.currentTimeMillis;
				const folders = yield* resolveSessionRequestFolders(
					"sessionId" in request ? request.sessionId : undefined,
				).pipe(Effect.timeoutOption(FILE_TREE_TIMEOUT_MS));
				if (Option.isNone(folders)) {
					const log = yield* LoggerTag;
					const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
					log.warn(
						`File tree deadline reached: "session folders" after ${elapsed} ms`,
					);
					return { projectSlug: config.slug, entries: [] };
				}
				const { workspaceRoot, effectiveFolders } = folders.value;
				if (!folders.value.workspaceRootPresent)
					return yield* new WsRpcError({
						message: `Workspace folder is missing: ${workspaceRoot}`,
					});
				const entries = yield* getFileTreeEntries(workspaceRoot, startedAt);
				const roots = labelProjectFolders(
					effectiveFolders.map(({ root }) => root),
				).map((folder, index) => ({
					...folder,
					...(effectiveFolders[index]?.shared ? { shared: true } : {}),
				}));
				return {
					projectSlug: config.slug,
					entries,
					...(roots.length > 1 || roots.some((folder) => folder.shared)
						? { roots }
						: {}),
				};
			}).pipe(
				Effect.catch((error) =>
					Effect.fail(
						new WsRpcError({
							message: `GetFileTree failed: ${String(error)}`,
						}),
					),
				),
			),
		),
	GetFileList: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			resolveFileDirectory(request).pipe(
				Effect.flatMap((directory) =>
					getFileListResponse(request.path ?? ".", directory),
				),
				Effect.map((result) => ({
					projectSlug: config.slug,
					...(request.root !== undefined ? { root: request.root } : {}),
					path: result.path,
					entries: result.entries,
				})),
				Effect.catch((error) =>
					Effect.fail(
						new WsRpcError({
							message: `GetFileList failed: ${String(error)}`,
						}),
					),
				),
			),
		),
	GetFileContent: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			resolveFileDirectory(request).pipe(
				Effect.flatMap((directory) =>
					getFileContentResponse(request.path, directory),
				),
				Effect.map((result) => ({
					projectSlug: config.slug,
					...(request.root !== undefined ? { root: request.root } : {}),
					path: result.path,
					content: result.content,
					...(result.binary != null ? { binary: result.binary } : {}),
				})),
				Effect.catch((error) =>
					Effect.fail(
						new WsRpcError({
							message: `GetFileContent failed: ${String(error)}`,
						}),
					),
				),
			),
		),
	GetToolDetails: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const toolContent = yield* ToolContentServiceTag;
			return {
				projectSlug: config.slug,
				tools: yield* toolContent.details(request.sessionId, request.toolIds),
			};
		}).pipe(Effect.catch(mapRpcFailure("GetToolDetails"))),
	GetSkillContent: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const skill = yield* getDiscoveredSkillForSession(
				request.skillRef,
				"sessionId" in request ? request.sessionId : undefined,
			);
			if (skill?.location._tag === "Provider") {
				return yield* Effect.fail(
					new WsRpcError({
						message: "Skill content not available: managed by the provider",
					}),
				);
			}
			const result = skill
				? yield* getSkillContentValue(skill.location)
				: undefined;
			if (skill === undefined || result === undefined) {
				return yield* Effect.fail(
					new WsRpcError({ message: "Skill content not available" }),
				);
			}
			return {
				projectSlug: config.slug,
				name: skill.name,
				...result,
			};
		}).pipe(Effect.catch(mapRpcFailure("GetSkillContent"))),
} satisfies Pick<
	WsRpcHandlerMap,
	| "FindFolders"
	| "GetFileTree"
	| "GetFileList"
	| "GetFileContent"
	| "GetToolDetails"
	| "GetSkillContent"
>;

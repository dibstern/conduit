import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { ProjectSaveRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import { DirectoryListingServiceTag } from "../../domain/relay/Services/directory-listing-service.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/provider-turn-dispatch.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../domain/relay/Services/session-workspace.js";
import { ToolContentServiceTag } from "../../domain/relay/Services/tool-content-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { formatErrorDetail } from "../../errors.js";
import {
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../../handlers/files.js";
import { getSkillContentValue } from "../../handlers/skill-content.js";
import { labelProjectFolders } from "../../project-folders.js";
import {
	mapRpcFailure,
	resolveSessionRequestDirectory,
	type WsRpcHandlerMap,
} from "./shared.js";

const containsPath = (directory: string, path: string) => {
	const within = relative(directory, path);
	return (
		within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
	);
};

const resolveFileDirectory = (request: {
	readonly sessionId?: string | undefined;
	readonly root?: string | undefined;
	readonly path?: string | undefined;
}) =>
	Effect.gen(function* () {
		const directory = yield* resolveSessionRequestDirectory(request, "file");
		const path = resolve(directory, request.path ?? ".");
		if (!containsPath(directory, path)) {
			return yield* Effect.fail(
				new WsRpcError({ message: "Path is outside the selected folder" }),
			);
		}
		if (request.root !== undefined) {
			const [realRoot, realPath] = yield* Effect.tryPromise(() =>
				Promise.all([realpath(directory), realpath(path)]),
			);
			if (!containsPath(realRoot, realPath)) {
				return yield* Effect.fail(
					new WsRpcError({ message: "Path is outside the selected folder" }),
				);
			}
		}
		return directory;
	});

export const filesHandlers = {
	FindFolders: (request) =>
		Effect.gen(function* () {
			const directoryListing = yield* DirectoryListingServiceTag;
			return yield* directoryListing.find(request.query);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.failCause(
					Failure.mapFailures(cause, (error) =>
						error instanceof ProjectSaveRejected
							? error
							: new WsRpcError({
									message: `FindFolders failed: ${formatErrorDetail(error)}`,
								}),
					),
				),
			),
		),
	GetFileTree: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			resolveSessionRequestFolders(
				"sessionId" in request ? request.sessionId : undefined,
			).pipe(
				Effect.flatMap(({ workspaceRoot, effectiveFolders }) =>
					Effect.gen(function* () {
						const entries = yield* getFileTreeEntries(workspaceRoot);
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
					}),
				),
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
			const primaryFolder = config.projectDir;
			const directory =
				"sessionId" in request
					? yield* (yield* SessionWorkspaceTag).get(request.sessionId)
					: primaryFolder;
			const result = yield* getSkillContentValue(request.name, directory);
			if (result === undefined) {
				return yield* Effect.fail(
					new WsRpcError({ message: "Skill content not available" }),
				);
			}
			return {
				projectSlug: config.slug,
				name: request.name,
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

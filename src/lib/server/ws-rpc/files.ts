import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { ProjectSaveRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import { DirectoryListingServiceTag } from "../../domain/relay/Services/directory-listing-service.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/provider-turn-dispatch.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../domain/relay/Services/session-workspace.js";
import { ToolContentServiceTag } from "../../domain/relay/Services/tool-content-service.js";
import { formatErrorDetail } from "../../errors.js";
import {
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../../handlers/files.js";
import { getSkillContentValue } from "../../handlers/skill-content.js";
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
			Effect.mapError((error) =>
				error instanceof ProjectSaveRejected
					? error
					: new WsRpcError({
							message: `FindFolders failed: ${formatErrorDetail(error)}`,
						}),
			),
		),
	GetFileTree: (request) =>
		resolveSessionRequestFolders(request.sessionId).pipe(
			Effect.flatMap(({ workspaceRoot, effectiveFolders }) =>
				Effect.gen(function* () {
					const entries = yield* getFileTreeEntries(workspaceRoot);
					const roots = effectiveFolders.map(({ root }) => ({
						root,
						label: basename(root) || root,
					}));
					return {
						projectSlug: request.projectSlug,
						entries,
						...(roots.length > 1
							? {
									roots: roots.map(({ root, label }) => ({
										root,
										label:
											roots.filter((folder) => folder.label === label).length >
											1
												? root
												: label,
									})),
								}
							: {}),
					};
				}),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileTree failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileList: (request) =>
		resolveFileDirectory(request).pipe(
			Effect.flatMap((directory) =>
				getFileListResponse(request.path ?? ".", directory),
			),
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				...(request.root !== undefined ? { root: request.root } : {}),
				path: result.path,
				entries: result.entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileList failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileContent: (request) =>
		resolveFileDirectory(request).pipe(
			Effect.flatMap((directory) =>
				getFileContentResponse(request.path, directory),
			),
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				...(request.root !== undefined ? { root: request.root } : {}),
				path: result.path,
				content: result.content,
				...(result.binary != null ? { binary: result.binary } : {}),
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileContent failed: ${String(error)}`,
					}),
				),
			),
		),
	GetToolDetails: (request) =>
		Effect.gen(function* () {
			const toolContent = yield* ToolContentServiceTag;
			return {
				projectSlug: request.projectSlug,
				tools: yield* toolContent.details(request.sessionId, request.toolIds),
			};
		}).pipe(Effect.catchAll(mapRpcFailure("GetToolDetails"))),
	GetSkillContent: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const primaryFolder = config.projectDir;
			const directory = request.sessionId
				? yield* (yield* SessionWorkspaceTag).get(request.sessionId)
				: primaryFolder;
			const result = yield* getSkillContentValue(
				request.name,
				config.slug === request.projectSlug ? directory : undefined,
			);
			if (result === undefined) {
				return yield* Effect.fail(
					new WsRpcError({ message: "Skill content not available" }),
				);
			}
			return {
				projectSlug: request.projectSlug,
				name: request.name,
				...result,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("GetSkillContent"))),
} satisfies Pick<
	WsRpcHandlerMap,
	| "FindFolders"
	| "GetFileTree"
	| "GetFileList"
	| "GetFileContent"
	| "GetToolDetails"
	| "GetSkillContent"
>;

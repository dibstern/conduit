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
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

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
			Effect.flatMap(({ workspaceRoot }) => getFileTreeEntries(workspaceRoot)),
			Effect.map((entries) => ({
				projectSlug: request.projectSlug,
				entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileTree failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileList: (request) =>
		resolveSessionRequestFolders(request.sessionId).pipe(
			Effect.flatMap(({ workspaceRoot }) =>
				getFileListResponse(request.path ?? ".", workspaceRoot),
			),
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
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
		resolveSessionRequestFolders(request.sessionId).pipe(
			Effect.flatMap(({ workspaceRoot }) =>
				getFileContentResponse(request.path, workspaceRoot),
			),
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
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
				tools: yield* toolContent.details(request.toolIds),
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

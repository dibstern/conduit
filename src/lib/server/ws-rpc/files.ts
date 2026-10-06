import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { DirectoryListingServiceTag } from "../../domain/relay/Services/directory-listing-service.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import { formatErrorDetail } from "../../errors.js";
import {
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../../handlers/files.js";
import { getTodoState } from "../../handlers/settings.js";
import { getSkillContentValue } from "../../handlers/skill-content.js";
import { getToolContentValue } from "../../handlers/tool-content.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const filesHandlers = {
	FindFolders: (request) =>
		Effect.gen(function* () {
			const directoryListing = yield* DirectoryListingServiceTag;
			return yield* directoryListing.find(request.query);
		}).pipe(
			Effect.mapError(
				(error) =>
					new WsRpcError({
						message: `FindFolders failed: ${formatErrorDetail(error)}`,
					}),
			),
		),
	GetTodo: (request) =>
		getTodoState().pipe(
			Effect.map((items) => ({
				projectSlug: request.projectSlug,
				items: [...items],
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetTodo failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileTree: (request) =>
		getFileTreeEntries().pipe(
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
		getFileListResponse(request.path ?? ".").pipe(
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
		getFileContentResponse(request.path).pipe(
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
	GetToolContent: (request) =>
		getToolContentValue(request.toolId).pipe(
			Effect.flatMap((content) =>
				content == null
					? Effect.fail(
							new WsRpcError({
								message: "Full tool content not available",
							}),
						)
					: Effect.succeed({
							projectSlug: request.projectSlug,
							toolId: request.toolId,
							content,
						}),
			),
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `GetToolContent failed: ${String(error)}`,
							}),
						),
			),
		),
	GetSkillContent: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const result = yield* getSkillContentValue(
				request.name,
				config.slug === request.projectSlug ? config.projectDir : undefined,
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
	| "GetTodo"
	| "GetFileTree"
	| "GetFileList"
	| "GetFileContent"
	| "GetToolContent"
	| "GetSkillContent"
>;

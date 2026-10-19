import { Context, Data, Effect, Layer } from "effect";
import type {
	ProjectSaveRejected,
	SaveProjectInput,
} from "../../../contracts/ws-rpc.js";
import type { FolderIssue } from "../../../project-folders.js";
import type { ProjectInfo } from "../../../shared-types.js";
import { ConfigTag } from "./services.js";

type ProjectOperation = "list" | "save" | "remove";

export interface SaveProjectResult {
	readonly kind?: "existing" | undefined;
	readonly project: ProjectInfo;
	readonly projects: ReadonlyArray<ProjectInfo>;
	readonly warnings: readonly FolderIssue[];
}

export class ProjectManagementServiceError extends Data.TaggedError(
	"ProjectManagementServiceError",
)<{
	readonly operation: ProjectOperation;
	readonly cause: unknown;
}> {}

export class ProjectManagementNotSupported extends Data.TaggedError(
	"ProjectManagementNotSupported",
)<{
	readonly operation: Exclude<ProjectOperation, "list">;
	readonly message: string;
}> {}

export interface ProjectManagementService {
	currentSlug(): Effect.Effect<string>;
	list(): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError
	>;
	save(
		input: SaveProjectInput,
	): Effect.Effect<
		SaveProjectResult,
		| ProjectManagementServiceError
		| ProjectManagementNotSupported
		| ProjectSaveRejected
	>;
	remove(
		slug: string,
	): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError | ProjectManagementNotSupported
	>;
}

export class ProjectManagementServiceTag extends Context.Service<
	ProjectManagementServiceTag,
	ProjectManagementService
>()("ProjectManagementService") {}

export const ProjectManagementServiceLive: Layer.Layer<
	ProjectManagementServiceTag,
	never,
	ConfigTag
> = Layer.effect(
	ProjectManagementServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		return {
			currentSlug: () => Effect.succeed(config.slug),
			list: () => Effect.succeed([]),
			save: () =>
				Effect.fail(
					new ProjectManagementNotSupported({
						operation: "save",
						message: "Saving projects is not supported in this mode",
					}),
				),
			remove: () =>
				Effect.fail(
					new ProjectManagementNotSupported({
						operation: "remove",
						message: "Removing projects is not supported in this mode",
					}),
				),
		};
	}),
);

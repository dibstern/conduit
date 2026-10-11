import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
	type ProjectFileResult,
	ProjectFileSchema,
} from "../contracts/project-file.js";

/** Read on every session creation, from the primary folder rather than a worktree. */
export const readProjectFile = (
	primaryFolder: string,
): Effect.Effect<ProjectFileResult> =>
	Effect.tryPromise(() =>
		readFile(join(primaryFolder, "conduit.json"), "utf8"),
	).pipe(
		Effect.flatMap((contents) =>
			Schema.decodeUnknown(Schema.parseJson(ProjectFileSchema))(contents).pipe(
				Effect.map((file): ProjectFileResult => ({ _tag: "parsed", file })),
				Effect.catchAll((error) =>
					Effect.succeed<ProjectFileResult>({
						_tag: "invalid",
						message: `Invalid conduit.json: ${error.message}`,
					}),
				),
			),
		),
		Effect.catchAll((error) =>
			Effect.succeed<ProjectFileResult>(
				typeof error.cause === "object" &&
					error.cause !== null &&
					"code" in error.cause &&
					error.cause.code === "ENOENT"
					? { _tag: "absent" }
					: {
							_tag: "invalid",
							message: `Could not read conduit.json: ${error.message}`,
						},
			),
		),
	);

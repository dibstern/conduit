import { Schema } from "effect";

export class WorktreeCreationError extends Schema.TaggedError<WorktreeCreationError>()(
	"WorktreeCreationError",
	{
		reason: Schema.Literal(
			"branch-exists",
			"invalid-branch",
			"detached-head",
			"target-exists",
			"git-failed",
			"unsupported-project",
		),
		path: Schema.String,
		message: Schema.String,
	},
) {}

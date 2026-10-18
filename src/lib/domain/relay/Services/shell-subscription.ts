import { Effect, Stream } from "effect";
import type {
	ResumeBase,
	ResumePoint,
	ShellProjectsFrame,
} from "../../../contracts/ws-rpc.js";
import { readProjectFile } from "../../../daemon/project-file.js";
import { withCachedProjectGit } from "../../../git/session-git.js";
import { subscribeShellProjects } from "../../daemon/Services/shell-subscription.js";
import { ConfigTag } from "./services.js";

export type {
	ShellSubscriptionError,
	SidebarRead,
} from "../../daemon/Services/shell-subscription.js";

/** Standalone relays retain their local store and bus, and serve only their project. */
export const subscribeShell = (
	options: {
		readonly resumeFromSequence?: number;
		readonly resumeBase?: ResumeBase;
		readonly resumePoint?: ResumePoint;
	} = {},
) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const file = yield* readProjectFile(config.projectDir);
			const frame: ShellProjectsFrame = {
				_tag: "projects",
				projects: withCachedProjectGit([
					{
						slug: config.slug,
						title: config.slug,
						folders: [config.projectDir, ...(config.extraFolders ?? [])],
						...(file._tag === "parsed" ? file.file : {}),
					},
				]),
				newSessionProject: config.slug,
			};
			return subscribeShellProjects(options, Stream.succeed(frame), {
				standalone: true,
			});
		}),
	);

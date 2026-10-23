import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	makeSubprocessRunner,
	type SubprocessRunner,
} from "../domain/daemon/Services/subprocess.js";
import type { RepositoryIdentity } from "../shared-types.js";

export type { RepositoryIdentity } from "../shared-types.js";

/** Only hosted remotes have a host/owner/repo key. Preserve case in the display name. */
export function normalizeRepositoryRemote(
	remote: string,
): Pick<RepositoryIdentity, "key" | "name"> | undefined {
	try {
		let host: string;
		let path: string;
		if (remote.includes("://")) {
			const url = new URL(remote);
			if (
				!["ssh:", "https:", "http:", "git:"].includes(url.protocol) ||
				url.search ||
				url.hash
			)
				return undefined;
			host = url.hostname;
			path = url.pathname;
		} else {
			const scp = remote.match(/^(?:[^/@:\s]+@)?(\[[^\]]+\]|[^/:@\s]+):(.+)$/);
			if (!scp?.[1] || !scp[2]) return undefined;
			host = scp[1];
			path = scp[2];
		}
		path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		const segments = path.split("/");
		const name = segments.at(-1);
		if (
			!host ||
			!name ||
			segments.length < 2 ||
			segments.some((part) => !part || part === "." || part === "..") ||
			/\s/.test(path)
		)
			return undefined;
		return { key: `${host}/${path}`.toLowerCase(), name };
	} catch {
		return undefined;
	}
}

/** Best-effort local discovery; git never contacts the origin or writes an index. */
export async function readRepositoryIdentity(
	directory: string,
	runner: SubprocessRunner = makeSubprocessRunner(),
): Promise<RepositoryIdentity | undefined> {
	try {
		const git = (...args: string[]) =>
			runner("git", args, {
				cwd: directory,
				timeoutMs: 2000,
				env: {
					...process.env,
					GIT_DIR: undefined,
					GIT_INDEX_FILE: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_OPTIONAL_LOCKS: "0",
				},
			});
		const { stdout, exitCode } = await git(
			"rev-parse",
			"--show-toplevel",
			"--git-common-dir",
		);
		if (exitCode !== 0) return undefined;
		const [toplevel, commonDir] = stdout.trim().split("\n");
		if (!toplevel || !commonDir) return undefined;
		const root = await realpath(toplevel);
		const common = await realpath(resolve(directory, commonDir));
		const configured = await git("config", "--get", "remote.origin.url");
		// Exit 1 means the key is absent; other git failures are not a local identity.
		if (configured.exitCode !== 0 && configured.exitCode !== 1)
			return undefined;
		const origin =
			configured.exitCode === 0 ? configured.stdout.trim() : undefined;
		// A local-path or malformed origin is no hosted identity: fall back to the shared git dir.
		const remote =
			origin === undefined ? undefined : normalizeRepositoryRemote(origin);
		return {
			key: remote?.key ?? common,
			name:
				remote?.name ??
				(basename(common) === ".git"
					? basename(dirname(common))
					: basename(common)),
			root,
		};
	} catch {
		return undefined;
	}
}

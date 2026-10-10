import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { RepositoryIdentity } from "../shared-types.js";

export type { RepositoryIdentity } from "../shared-types.js";

const execFileAsync = promisify(execFile);

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
): Promise<RepositoryIdentity | undefined> {
	try {
		const git = (...args: string[]) =>
			execFileAsync("git", args, {
				cwd: directory,
				encoding: "utf8",
				timeout: 2000,
				env: {
					...process.env,
					GIT_DIR: undefined,
					GIT_INDEX_FILE: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_OPTIONAL_LOCKS: "0",
				},
			});
		const { stdout } = await git(
			"rev-parse",
			"--show-toplevel",
			"--git-common-dir",
		);
		const [toplevel, commonDir] = stdout.trim().split("\n");
		if (!toplevel || !commonDir) return undefined;
		const root = await realpath(toplevel);
		const common = await realpath(resolve(directory, commonDir));
		let origin: string | undefined;
		try {
			origin = (
				await git("config", "--get", "remote.origin.url")
			).stdout.trim();
		} catch (cause) {
			// Exit 1 means the key is absent; other git failures are not a local identity.
			if (
				typeof cause !== "object" ||
				cause === null ||
				!("code" in cause) ||
				cause.code !== 1
			)
				return undefined;
		}
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

import fs from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Effect } from "effect";

const MAX_CONTENT_BYTES = 256 * 1024;

export const getSkillContentValue = (
	name: string,
	projectCwd: string | undefined,
) =>
	Effect.gen(function* () {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return undefined;

		const roots = [
			...(projectCwd ? [join(projectCwd, ".claude", "skills")] : []),
			join(os.homedir(), ".claude", "skills"),
		];
		for (const root of roots) {
			const result = yield* Effect.either(
				Effect.tryPromise(async () => {
					const realRoot = await fs.realpath(root);
					const path = await fs.realpath(join(root, name, "SKILL.md"));
					const withinRoot = relative(realRoot, path);
					if (
						withinRoot === ".." ||
						withinRoot.startsWith(`..${sep}`) ||
						isAbsolute(withinRoot)
					) {
						return undefined;
					}

					const file = await fs.open(path, "r");
					try {
						if (!(await file.stat()).isFile()) return undefined;
						const buffer = Buffer.alloc(MAX_CONTENT_BYTES);
						let length = 0;
						while (length < buffer.length) {
							const { bytesRead } = await file.read(
								buffer,
								length,
								buffer.length - length,
								length,
							);
							if (bytesRead === 0) break;
							length += bytesRead;
						}
						return { path, content: buffer.toString("utf8", 0, length) };
					} finally {
						await file.close();
					}
				}),
			);
			if (result._tag === "Right" && result.right !== undefined) {
				return result.right;
			}
		}
		return undefined;
	});

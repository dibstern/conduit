import fs from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { Effect } from "effect";
import type { DiscoveredSkill } from "../provider/types.js";

const MAX_CONTENT_BYTES = 256 * 1024;

export const getSkillContentValue = (
	location: Extract<DiscoveredSkill["location"], { readonly _tag: "File" }>,
) =>
	Effect.gen(function* () {
		const result = yield* Effect.result(
			Effect.tryPromise(async () => {
				const realRoot = await fs.realpath(location.root);
				const path = await fs.realpath(location.path);
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
		if (result._tag === "Success" && result.success !== undefined) {
			return result.success;
		}
		return undefined;
	});

import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect, Schema } from "effect";
import { parse } from "yaml";
import type { DiscoveredSkill } from "../types.js";

// @cursor/sdk 1.0.37, dist/esm/464.js: oh/ch/lh, rh/ih and vh.
// Local SDK mode enables third-party extensibility. Keep this list in its order.
const CONFIG_DIRS = [".cursor", ".claude", ".codex", ".grok", ".agents"];
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "dist", "build"]);
const MAX_DEPTH = 10;
const MAX_ENTRIES = 8192;
const MAX_DIRECTORIES = 2048;
const MAX_SKILLS = 256;
const MAX_CONTENT_BYTES = 256 * 1024;
// SDK nh filters these bundled Codex skills, but only in .codex/skills.
const CODEX_BUNDLED_SKILLS = new Set([
	"imagegen",
	"openai-docs",
	"opneai-docs",
	"plugin-creator",
	"skill-creator",
	"skill-installer",
]);

const decodeFrontmatter = Schema.decodeUnknownOption(
	Schema.Struct({
		description: Schema.optional(Schema.String),
		"disable-model-invocation": Schema.optional(Schema.Boolean),
		alwaysApply: Schema.optional(Schema.Boolean),
		metadata: Schema.optional(
			Schema.Struct({
				surfaces: Schema.optional(
					Schema.Union([Schema.String, Schema.Array(Schema.String)]),
				),
			}),
		),
	}),
);

const decodePluginManifest = Schema.decodeUnknownOption(
	Schema.Struct({
		name: Schema.String.check(
			Schema.isPattern(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/),
		),
		skills: Schema.optional(
			Schema.Union([Schema.String, Schema.Array(Schema.String)]),
		),
	}),
);

async function readDocument(path: string): Promise<string | undefined> {
	if (!(await stat(path).catch(() => undefined))?.isFile()) return undefined;
	const file = await open(path, "r").catch(() => undefined);
	if (!file) return undefined;
	try {
		if (!(await file.stat()).isFile()) return undefined;
		const buffer = Buffer.alloc(MAX_CONTENT_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}

async function readSkill(
	directory: string,
	source: DiscoveredSkill["source"],
): Promise<DiscoveredSkill | undefined> {
	if (
		directory.includes(`${sep}.codex${sep}skills${sep}`) &&
		CODEX_BUNDLED_SKILLS.has(basename(directory))
	)
		return undefined;
	const content = await readDocument(join(directory, "SKILL.md"));
	if (content === undefined) return undefined;
	try {
		const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
			content,
		);
		if (!block) return undefined;
		const frontmatter: unknown = parse(block[1] ?? "", { maxAliasCount: 10 });
		const decoded = decodeFrontmatter(frontmatter);
		if (decoded._tag === "None") return undefined;
		const fm = decoded.value;
		const surfaces =
			typeof fm.metadata?.surfaces === "string"
				? fm.metadata.surfaces
						.split(",")
						.map((surface) => surface.trim())
						.filter(Boolean)
				: (fm.metadata?.surfaces ?? []);
		// SDK Bh/jh/Nh: manual-only skills remain invocable; global and non-SDK rules do not.
		if (fm.alwaysApply || (surfaces.length > 0 && !surfaces.includes("sdk")))
			return undefined;
		if (!fm.description?.trim() && !fm["disable-model-invocation"])
			return undefined;
		const name = basename(directory);
		if (/\s/.test(name)) return undefined;
		return {
			name,
			source,
			location: {
				_tag: "File",
				path: join(directory, "SKILL.md"),
				root: directory,
			},
			...(fm.description ? { description: fm.description } : {}),
		};
	} catch {
		return undefined;
	}
}

export const discoverCursorSkillsEffect = (
	workspaceRoot: string,
): Effect.Effect<DiscoveredSkill[]> =>
	Effect.tryPromise(async () => {
		const commands = new Map<string, DiscoveredSkill>();
		const visited = new Set<string>();
		let entries = 0;
		let directories = 0;
		const exhausted = () =>
			entries >= MAX_ENTRIES ||
			directories >= MAX_DIRECTORIES ||
			commands.size >= MAX_SKILLS;
		const collect = async (
			directory: string,
			source: DiscoveredSkill["source"],
		) => {
			const command = await readSkill(directory, source);
			if (command && !commands.has(command.name))
				commands.set(command.name, command);
		};
		const scan = async (root: string, source: DiscoveredSkill["source"]) => {
			const canonicalRoot = await realpath(root).catch(() => undefined);
			if (!canonicalRoot) return;
			const pending = [{ path: root, depth: 0 }];
			for (let index = 0; index < pending.length && !exhausted(); index++) {
				const current = pending[index];
				if (!current) continue;
				const canonical = await realpath(current.path).catch(() => undefined);
				if (!canonical || visited.has(canonical)) continue;
				visited.add(canonical);
				directories++;
				const outside = relative(canonicalRoot, canonical);
				if (
					outside === ".." ||
					outside.startsWith(`..${sep}`) ||
					isAbsolute(outside)
				) {
					// Linked skills may expose their own document, never the target's descendants.
					await collect(current.path, source);
					continue;
				}
				const dir = await opendir(current.path).catch(() => undefined);
				if (!dir) continue;
				for await (const entry of dir) {
					if (exhausted()) break;
					entries++;
					if (
						entry.name === "SKILL.md" &&
						(entry.isFile() || entry.isSymbolicLink())
					)
						await collect(current.path, source);
					if (
						current.depth >= MAX_DEPTH ||
						entry.name.startsWith(".") ||
						SKIPPED_DIRS.has(entry.name)
					)
						continue;
					if (entry.isDirectory() || entry.isSymbolicLink())
						pending.push({
							path: join(current.path, entry.name),
							depth: current.depth + 1,
						});
				}
			}
		};
		for (const [directory, source] of [
			[workspaceRoot, "project-skill"],
			[homedir(), "user-skill"],
		] as const) {
			for (const config of CONFIG_DIRS) {
				if (exhausted()) break;
				await scan(join(directory, config, "skills"), source).catch(
					() => undefined,
				);
			}
		}
		// VC.prepareLocalExtensibility enables this managed cache after team sync.
		if (!exhausted())
			await scan(
				join(homedir(), ".cursor", "skills-cursor"),
				"user-skill",
			).catch(() => undefined);
		const within = (root: string, path: string) => {
			const offset = relative(root, path);
			return (
				offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
			);
		};
		const pluginDocument = async (root: string, path: string) => {
			if (exhausted()) return undefined;
			entries++;
			const canonical = await realpath(path).catch(() => undefined);
			if (
				!canonical ||
				!within(root, canonical) ||
				relative(root, dirname(canonical)).split(sep).filter(Boolean).length >
					MAX_DEPTH
			)
				return undefined;
			return readDocument(path);
		};
		const pluginChildren = async (
			root: string,
			path: string,
			hideDotDirectories = false,
		) => {
			const children: string[] = [];
			const canonical = await realpath(path).catch(() => undefined);
			if (
				exhausted() ||
				!canonical ||
				!within(root, canonical) ||
				relative(root, canonical).split(sep).filter(Boolean).length >= MAX_DEPTH
			)
				return children;
			const dir = await opendir(path).catch(() => undefined);
			if (!dir) return children;
			directories++;
			for await (const entry of dir) {
				if (exhausted()) break;
				entries++;
				if (
					(hideDotDirectories && entry.name.startsWith(".")) ||
					(!entry.isDirectory() && !entry.isSymbolicLink())
				)
					continue;
				const child = join(path, entry.name);
				const target = await realpath(child).catch(() => undefined);
				if (
					target &&
					within(root, target) &&
					(await stat(child).catch(() => undefined))?.isDirectory()
				)
					children.push(child);
			}
			return children;
		};
		const collectPlugin = async (root: string, path: string) => {
			const content = await pluginDocument(root, path);
			if (content === undefined) return false;
			try {
				const block =
					/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
				const parsed: unknown = parse(block?.[1] ?? "", { maxAliasCount: 10 });
				const fm =
					parsed && typeof parsed === "object" && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: {};
				const suppliedName =
					typeof fm["name"] === "string" ? fm["name"].trim() : "";
				// SDK rd/bd/ep: plugin names use frontmatter, descriptions are optional,
				// and surfaces are ignored. Root SKILL.md needs an explicit name.
				if (
					fm["alwaysApply"] === true ||
					(!suppliedName && dirname(path) === root)
				)
					return true;
				const name = suppliedName || basename(dirname(path));
				if (!commands.has(name))
					commands.set(name, {
						name,
						source: "plugin-skill",
						location: { _tag: "File", path, root },
						...(typeof fm["description"] === "string"
							? { description: fm["description"] }
							: {}),
					});
			} catch {
				// One malformed document does not discard the plugin's other skills.
			}
			return true;
		};
		// SDK ck.load/Id/pd/rd: local plugins load by presence, independently of
		// marketplace registrations. Never infer enabled plugins from cache contents.
		const localRoot = await realpath(
			join(homedir(), ".cursor", "plugins", "local"),
		).catch(() => undefined);
		if (localRoot)
			for (const plugin of await pluginChildren(localRoot, localRoot, true)) {
				if (exhausted()) break;
				const root = await realpath(plugin).catch(() => undefined);
				if (!root) continue;
				let selected: string | readonly string[] | undefined;
				for (const manifest of [
					".cursor-plugin/plugin.json",
					".claude-plugin/plugin.json",
					"plugin.json",
				]) {
					const path = join(root, manifest);
					if ((await lstat(path).catch(() => undefined))?.isSymbolicLink())
						continue;
					const content = await pluginDocument(root, path);
					if (content === undefined) continue;
					try {
						const parsed: unknown = JSON.parse(content);
						const decoded = decodePluginManifest(parsed);
						if (decoded._tag === "None") continue;
						const fields = parsed as Record<string, unknown>;
						if (
							![
								"commands",
								"agents",
								"skills",
								"rules",
								"hooks",
								"mcpServers",
								"displayName",
								"description",
								"author",
								"logo",
								"variables",
								"capabilities",
							].some((field) => fields[field] !== undefined)
						)
							continue;
						selected = decoded.value.skills;
						break;
					} catch {
						// Invalid manifests fall through to the next supported location.
					}
				}
				if (selected === undefined)
					await collectPlugin(root, join(root, "SKILL.md"));
				for (const selection of selected === undefined
					? ["skills"]
					: typeof selected === "string"
						? [selected]
						: selected) {
					if (exhausted()) break;
					if (
						selection.includes("..") ||
						isAbsolute(selection) ||
						selection.includes("://")
					)
						continue;
					const path = join(root, selection.replace(/^\.\//, ""));
					if (
						Array.isArray(selected) &&
						(await collectPlugin(
							root,
							path.endsWith("SKILL.md") ? path : join(path, "SKILL.md"),
						))
					)
						continue;
					for (const child of await pluginChildren(root, path)) {
						if (exhausted()) break;
						await collectPlugin(root, join(child, "SKILL.md"));
					}
				}
			}
		// SDK wh/NestedExtensibilityService also discovers package-local roots in Git workspaces.
		let repository = false;
		for (let path = workspaceRoot, depth = 0; depth <= MAX_DEPTH; depth++) {
			if (await stat(join(path, ".git")).catch(() => undefined)) {
				repository = true;
				break;
			}
			const parent = dirname(path);
			if (parent === path) break;
			path = parent;
		}
		if (repository) {
			const pending = [{ path: workspaceRoot, depth: 0 }];
			for (let index = 0; index < pending.length && !exhausted(); index++) {
				const current = pending[index];
				if (!current) continue;
				directories++;
				const dir = await opendir(current.path).catch(() => undefined);
				if (!dir) continue;
				for await (const entry of dir) {
					if (exhausted()) break;
					entries++;
					if (!entry.isDirectory()) continue;
					if (current.depth > 0 && CONFIG_DIRS.includes(entry.name))
						await scan(
							join(current.path, entry.name, "skills"),
							"project-skill",
						).catch(() => undefined);
					if (
						current.depth < MAX_DEPTH &&
						!entry.name.startsWith(".") &&
						!SKIPPED_DIRS.has(entry.name)
					)
						pending.push({
							path: join(current.path, entry.name),
							depth: current.depth + 1,
						});
				}
			}
		}
		return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
	}).pipe(Effect.orElseSucceed(() => []));

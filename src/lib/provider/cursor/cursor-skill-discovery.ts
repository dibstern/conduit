import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { Effect, Schema } from "effect";
import { parse } from "yaml";
import { makeSubprocessRunner } from "../../domain/daemon/Services/subprocess.js";
import type { DiscoveredSkill } from "../types.js";
import type { CursorAgentOptions } from "./sdk-port.js";

// Pinned against SDK 1.0.40 by cursor-skills-real-sdk.test.ts's offline rows.
const CONFIG_DIRS = [".cursor", ".claude", ".codex", ".grok", ".agents"];
type SkillRoot = "workspace" | "nested" | "home" | "managed" | "plugin";
// Root       | Rule
// workspace  | Git toplevel for one root; deduplicated cwd + dirs otherwise.
// nested     | Same realpath filter as workspace; follow directory symlinks.
// home       | Realpath homedir, only with the user source enabled.
// managed    | Team source; trust the on-disk managed cache.
// plugin     | Plugin bootstrap rules only; no workspace/home filter.
const SKILL_SOURCES: Record<SkillRoot, DiscoveredSkill["source"]> = {
	workspace: "project-skill",
	nested: "project-skill",
	home: "user-skill",
	managed: "user-skill",
	plugin: "plugin-skill",
};
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
	cwd: string,
	options: Partial<Pick<CursorAgentOptions, "dirs" | "settingSources">> = {},
): Effect.Effect<DiscoveredSkill[]> =>
	Effect.tryPromise(async (signal) => {
		const run = makeSubprocessRunner();
		const gitToplevel = (directory: string) =>
			run(
				"git",
				["rev-parse", "--show-toplevel"],
				{ cwd: directory, timeoutMs: 5000, maxBuffer: 64 * 1024 },
				signal,
			)
				.then(({ stdout, exitCode }) =>
					exitCode === 0 ? stdout.trim() || undefined : undefined,
				)
				.catch(() => undefined);
		const sources = options.settingSources ?? [
			"project",
			"user",
			"team",
			"mdm",
			"plugins",
		];
		const folders = [
			...new Map(
				[cwd, ...(options.dirs ?? [])].map((path) => [resolve(path), path]),
			).values(),
		];
		const gitRoot = folders.length === 1 ? await gitToplevel(cwd) : undefined;
		const workspaceRoots =
			folders.length === 1 && gitRoot ? [gitRoot] : folders;
		const home = homedir();
		const managedRoot = join(home, ".cursor", "skills-cursor");
		// Treat the on-disk managed cache as synced; offline, the SDK excludes it.
		const includeManaged = sources.includes("team");
		// Match the SDK's case-sensitive, slash-normalized realpath comparison.
		const normalize = (path: string) =>
			path.replace(/\\/g, "/").replace(/\/+$/, "");
		const canonical = async (path: string) =>
			normalize(await realpath(path).catch(() => path));
		const allowedRoots = await Promise.all(
			[
				...(sources.includes("project") ? workspaceRoots : []),
				...(sources.includes("user") ? [home] : []),
				...(includeManaged ? [managedRoot] : []),
			].map(canonical),
		);
		const canonicalManaged = await canonical(managedRoot);
		const inside = (path: string, root: string) =>
			path === root || path.startsWith(`${root}/`);
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
			kind: Exclude<SkillRoot, "plugin">,
		) => {
			const path = await realpath(join(directory, "SKILL.md")).catch(
				() => undefined,
			);
			if (!path) return;
			const file = normalize(path);
			if (
				(!includeManaged && inside(file, canonicalManaged)) ||
				!allowedRoots.some((root) => inside(file, root))
			)
				return;
			const command = await readSkill(directory, SKILL_SOURCES[kind]);
			if (command && !commands.has(command.name))
				commands.set(command.name, command);
		};
		const scan = async (root: string, kind: Exclude<SkillRoot, "plugin">) => {
			const pending = [{ path: root, depth: 0 }];
			for (let index = 0; index < pending.length && !exhausted(); index++) {
				const current = pending[index];
				if (!current) continue;
				const canonical = await realpath(current.path).catch(() => undefined);
				if (!canonical || visited.has(canonical)) continue;
				visited.add(canonical);
				directories++;
				const dir = await opendir(current.path).catch(() => undefined);
				if (!dir) continue;
				for await (const entry of dir) {
					if (exhausted()) break;
					entries++;
					if (
						entry.name === "SKILL.md" &&
						(entry.isFile() || entry.isSymbolicLink())
					)
						await collect(current.path, kind);
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
		for (const [directory, kind] of [
			...(sources.includes("project")
				? workspaceRoots.map((root) => [root, "workspace"] as const)
				: []),
			...(sources.includes("user") ? [[home, "home"] as const] : []),
		] as const) {
			for (const config of CONFIG_DIRS) {
				if (exhausted()) break;
				await scan(join(directory, config, "skills"), kind).catch(
					() => undefined,
				);
			}
		}
		if (includeManaged && !exhausted())
			await scan(managedRoot, "managed").catch(() => undefined);
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
						source: SKILL_SOURCES.plugin,
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
		if (sources.includes("plugins") && localRoot)
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
		if (sources.includes("project")) {
			for (const workspaceRoot of workspaceRoots) {
				if (!(await gitToplevel(workspaceRoot))) continue;
				const pending = [{ path: workspaceRoot, depth: 0 }];
				const visitedDirectories = new Set<string>();
				for (let index = 0; index < pending.length && !exhausted(); index++) {
					const current = pending[index];
					if (!current) continue;
					const canonical = await realpath(current.path).catch(() => undefined);
					if (!canonical || visitedDirectories.has(canonical)) continue;
					visitedDirectories.add(canonical);
					directories++;
					const dir = await opendir(current.path).catch(() => undefined);
					if (!dir) continue;
					for await (const entry of dir) {
						if (exhausted()) break;
						entries++;
						const directory =
							entry.isDirectory() ||
							(entry.isSymbolicLink() &&
								(
									await stat(join(current.path, entry.name)).catch(
										() => undefined,
									)
								)?.isDirectory());
						if (!directory) continue;
						if (current.depth > 0 && CONFIG_DIRS.includes(entry.name))
							await scan(
								join(current.path, entry.name, "skills"),
								"nested",
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
		}
		return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
	}).pipe(Effect.orElseSucceed(() => []));

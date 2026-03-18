// ─── Projects Submenu (Ticket 8.11) ──────────────────────────────────────────
// Interactive CLI projects submenu for opencode-relay. Displays project list
// with status, handles add/remove/title operations, and project detail view.
// Ported from claude-relay/bin/cli.js lines 1487-1679.

import * as fs from "node:fs";
import { basename, resolve } from "node:path";
import { printLogo } from "./cli-setup.js";
import type { PromptOptions, SelectPromptOptions } from "./prompts.js";
import { promptSelect, promptText } from "./prompts.js";
import { a, log, sym } from "./terminal-render.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Status information for a single project. */
export interface ProjectStatus {
	slug: string;
	path: string;
	title?: string;
	sessions: number;
	clients: number;
	isProcessing: boolean;
}

/** Options for the projects submenu. */
export interface ProjectsMenuOptions extends PromptOptions {
	/** Get list of projects from daemon status. */
	getProjects: () => ProjectStatus[] | Promise<ProjectStatus[]>;
	/** Current working directory. */
	cwd: string;
	/** IPC: add a project. */
	addProject: (
		directory: string,
	) => Promise<{ ok: boolean; slug?: string; error?: string }>;
	/** IPC: remove a project. */
	removeProject: (slug: string) => Promise<{ ok: boolean; error?: string }>;
	/** IPC: set project title. */
	setProjectTitle: (
		slug: string,
		title: string,
	) => Promise<{ ok: boolean; error?: string }>;
	/** Callback: return to main menu. */
	onBack: () => void | Promise<void>;
	/** Injectable filesystem for directory validation (defaults to real node:fs). */
	fs?: { statSync(p: string): { isDirectory(): boolean } };
}

// ─── Status Icon ─────────────────────────────────────────────────────────────

/** Get the status icon for a project. */
export function getStatusIcon(project: ProjectStatus): string {
	if (project.isProcessing) return "\u26A1";
	if (project.clients > 0) return "\uD83D\uDFE2";
	return "\u23F8";
}

// ─── Projects Menu ───────────────────────────────────────────────────────────

/**
 * Show the projects submenu.
 *
 * 1. Fetches projects via getProjects()
 * 2. Displays project list with status icons
 * 3. Shows add/detail/back menu items
 * 4. Dispatches to appropriate action
 */
export async function showProjectsMenu(
	opts: ProjectsMenuOptions,
): Promise<void> {
	const projects = await opts.getProjects();

	// Clear screen + logo
	printLogo(opts.stdout);

	// Header
	log(`${sym.pointer}  ${a.bold}Projects${a.reset}`, opts.stdout);
	log(sym.bar, opts.stdout);

	// Display each project
	for (let i = 0; i < projects.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by length
		const p = projects[i]!;
		const statusIcon = getStatusIcon(p);
		const sessionLabel =
			p.sessions === 1 ? "1 session" : `${p.sessions} sessions`;
		const projName = p.title || basename(p.path);
		log(
			`${sym.bar}  ${a.bold}${projName}${a.reset}    ${sessionLabel}    ${statusIcon}`,
			opts.stdout,
		);
		log(`${sym.bar}  ${a.dim}${p.path}${a.reset}`, opts.stdout);
		if (i < projects.length - 1) log(sym.bar, opts.stdout);
	}
	log(sym.bar, opts.stdout);

	// Build menu items
	type MenuValue = string;
	const items: Array<{ label: string; value: MenuValue }> = [];

	// Check if cwd is already registered
	let cwdRegistered = false;
	for (const p of projects) {
		if (p.path === opts.cwd) {
			cwdRegistered = true;
			break;
		}
	}
	if (!cwdRegistered) {
		items.push({
			label: `+ Add ${a.bold}${basename(opts.cwd)}${a.reset} ${a.dim}(${opts.cwd})${a.reset}`,
			value: "add_cwd",
		});
	}
	items.push({ label: "+ Add project...", value: "add_other" });

	for (const p of projects) {
		const itemLabel = p.title || basename(p.path);
		items.push({ label: itemLabel, value: `detail:${p.slug}` });
	}

	// Visible back item at the bottom of the list
	items.push({ label: `${a.dim}Back${a.reset}`, value: "back" });

	// Select prompt with back item (Backspace shortcut)
	const selectOpts: SelectPromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
		backItem: "Back",
	};

	return new Promise<void>((promiseResolve) => {
		promptSelect<MenuValue>(
			"Select",
			items,
			async (choice) => {
				if (choice === null || choice === "back") {
					// Back (via Backspace or menu item)
					await opts.onBack();
					promiseResolve();
					return;
				}

				if (choice === "add_cwd") {
					const res = await opts.addProject(opts.cwd);
					if (res.ok) {
						log(
							`${sym.done}  ${a.green}Added: ${res.slug}${a.reset}`,
							opts.stdout,
						);
					} else {
						log(
							`${sym.warn}  ${a.yellow}${res.error || "Failed"}${a.reset}`,
							opts.stdout,
						);
					}
					log("", opts.stdout);
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				if (choice === "add_other") {
					await handleAddOther(opts, projects);
					promiseResolve();
					return;
				}

				if (choice.startsWith("detail:")) {
					const detailSlug = choice.substring(7);
					await showProjectDetail(opts, detailSlug, projects);
					promiseResolve();
					return;
				}

				promiseResolve();
			},
			selectOpts,
		);
	});
}

// ─── Add Other ───────────────────────────────────────────────────────────────

/** Handle the "Add project..." flow with directory prompt and validation. */
async function handleAddOther(
	opts: ProjectsMenuOptions,
	projects: ProjectStatus[],
): Promise<void> {
	log(sym.bar, opts.stdout);

	return new Promise<void>((promiseResolve) => {
		promptText(
			"Directory path",
			opts.cwd,
			async (dirPath) => {
				if (dirPath === null) {
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				const absPath = resolve(dirPath);
				const fsImpl = opts.fs ?? fs;

				// Validate directory
				try {
					const stat = fsImpl.statSync(absPath);
					if (!stat.isDirectory()) {
						log(
							`${sym.warn}  ${a.red}Not a directory: ${absPath}${a.reset}`,
							opts.stdout,
						);
						await showProjectsMenu(opts);
						promiseResolve();
						return;
					}
				} catch {
					log(
						`${sym.warn}  ${a.red}Directory not found: ${absPath}${a.reset}`,
						opts.stdout,
					);
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				// Check if already registered
				let alreadyExists = false;
				for (const p of projects) {
					if (p.path === absPath) {
						alreadyExists = true;
						break;
					}
				}
				if (alreadyExists) {
					log(
						`${sym.done}  ${a.yellow}Already added: ${basename(absPath)}${a.reset} ${a.dim}(${absPath})${a.reset}`,
						opts.stdout,
					);
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				// Add the project
				const res = await opts.addProject(absPath);
				if (res.ok) {
					log(
						`${sym.done}  ${a.green}Added: ${res.slug}${a.reset} ${a.dim}(${absPath})${a.reset}`,
						opts.stdout,
					);
				} else {
					log(
						`${sym.warn}  ${a.yellow}${res.error || "Failed"}${a.reset}`,
						opts.stdout,
					);
				}
				await showProjectsMenu(opts);
				promiseResolve();
			},
			{ stdin: opts.stdin, stdout: opts.stdout, exit: opts.exit },
		);
	});
}

// ─── Project Detail ──────────────────────────────────────────────────────────

/**
 * Show the project detail submenu.
 *
 * 1. Displays project info (name, slug, path)
 * 2. Shows sessions/clients counts
 * 3. Menu: Set/Change title, Remove project, Back
 */
export async function showProjectDetail(
	opts: ProjectsMenuOptions,
	slug: string,
	projects: ProjectStatus[],
): Promise<void> {
	let proj: ProjectStatus | null = null;
	for (const p of projects) {
		if (p.slug === slug) {
			proj = p;
			break;
		}
	}

	if (!proj) {
		await showProjectsMenu(opts);
		return;
	}
	const safeProj = proj;

	const displayName = proj.title || basename(proj.path);

	// Clear screen + logo
	printLogo(opts.stdout);

	// Project info header
	log(
		`${sym.pointer}  ${a.bold}${displayName}${a.reset}  ${a.dim}${proj.slug} \u00B7 ${proj.path}${a.reset}`,
		opts.stdout,
	);
	log(sym.bar, opts.stdout);

	// Sessions / clients
	const sessionLabel =
		proj.sessions === 1 ? "1 session" : `${proj.sessions} sessions`;
	const clientLabel =
		proj.clients === 1 ? "1 client" : `${proj.clients} clients`;
	log(`${sym.bar}  ${sessionLabel} \u00B7 ${clientLabel}`, opts.stdout);

	// Custom title display
	if (proj.title) {
		log(`${sym.bar}  ${a.dim}Title: ${a.reset}${proj.title}`, opts.stdout);
	}
	log(sym.bar, opts.stdout);

	// Menu items
	type DetailChoice = "title" | "remove" | "back";
	const items: Array<{ label: string; value: DetailChoice }> = [
		{
			label: proj.title ? "Change title" : "Set title",
			value: "title" as const,
		},
		{ label: "Remove project", value: "remove" as const },
	];

	const selectOpts: SelectPromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
		backItem: "Back",
	};

	return new Promise<void>((promiseResolve) => {
		promptSelect<DetailChoice>(
			"What would you like to do?",
			items,
			async (choice) => {
				if (choice === null || choice === "back") {
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				if (choice === "title") {
					await handleSetTitle(opts, slug, safeProj, projects);
					promiseResolve();
					return;
				}

				if (choice === "remove") {
					const res = await opts.removeProject(slug);
					if (res.ok) {
						log(
							`${sym.done}  ${a.green}Removed: ${slug}${a.reset}`,
							opts.stdout,
						);
					} else {
						log(
							`${sym.warn}  ${a.yellow}${res.error || "Failed"}${a.reset}`,
							opts.stdout,
						);
					}
					log("", opts.stdout);
					await showProjectsMenu(opts);
					promiseResolve();
					return;
				}

				promiseResolve();
			},
			selectOpts,
		);
	});
}

// ─── Set Title ───────────────────────────────────────────────────────────────

/** Handle the set/change title flow. */
async function handleSetTitle(
	opts: ProjectsMenuOptions,
	slug: string,
	proj: ProjectStatus,
	projects: ProjectStatus[],
): Promise<void> {
	log(sym.bar, opts.stdout);

	return new Promise<void>((promiseResolve) => {
		promptText(
			"Project title",
			proj.title || basename(proj.path),
			async (newTitle) => {
				if (newTitle === null) {
					await showProjectDetail(opts, slug, projects);
					promiseResolve();
					return;
				}

				const titleVal = newTitle.trim();
				const res = await opts.setProjectTitle(slug, titleVal);
				if (res.ok) {
					if (titleVal) {
						proj.title = titleVal;
					} else {
						delete proj.title;
					}
					log(`${sym.done}  ${a.green}Title updated${a.reset}`, opts.stdout);
				} else {
					log(
						`${sym.warn}  ${a.yellow}${res.error || "Failed"}${a.reset}`,
						opts.stdout,
					);
				}
				log("", opts.stdout);
				await showProjectDetail(opts, slug, projects);
				promiseResolve();
			},
			{ stdin: opts.stdin, stdout: opts.stdout, exit: opts.exit },
		);
	});
}

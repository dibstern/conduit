// ─── Project Registry ───────────────────────────────────────────────────────
// Single source of truth for project lifecycle in the daemon. Replaces the
// three independent data structures (projects, projectRelays, pendingRelaySlugs)
// with a typed discriminated union.

import type { ProjectRelay } from "../relay/relay-stack.js";
import type { RelayMessage, StoredProject } from "../types.js";
import { TrackedService } from "./tracked-service.js";

// ─── Discriminated union ────────────────────────────────────────────────────

export interface ProjectRegistering {
	readonly status: "registering";
	readonly project: StoredProject;
}

export interface ProjectReady {
	readonly status: "ready";
	readonly project: StoredProject;
	readonly relay: ProjectRelay;
}

export interface ProjectError {
	readonly status: "error";
	readonly project: StoredProject;
	readonly error: string;
}

export type ProjectEntry = ProjectRegistering | ProjectReady | ProjectError;

// ─── Events ─────────────────────────────────────────────────────────────────

export type ProjectRegistryEvents = {
	project_added: [slug: string, project: StoredProject];
	project_ready: [slug: string, relay: ProjectRelay];
	project_error: [slug: string, error: string];
	project_updated: [slug: string, project: StoredProject];
	project_removed: [slug: string];
};

// ─── Registry class ─────────────────────────────────────────────────────────

export class ProjectRegistry extends TrackedService<ProjectRegistryEvents> {
	private readonly entries = new Map<string, ProjectEntry>();
	private readonly abortControllers = new Map<string, AbortController>();

	// ── Queries ──────────────────────────────────────────────────────────

	get(slug: string): ProjectEntry | undefined {
		const entry = this.entries.get(slug);
		if (!entry) return undefined;
		return { ...entry, project: { ...entry.project } };
	}

	getProject(slug: string): StoredProject | undefined {
		const project = this.entries.get(slug)?.project;
		return project ? { ...project } : undefined;
	}

	getRelay(slug: string): ProjectRelay | undefined {
		const entry = this.entries.get(slug);
		return entry?.status === "ready" ? entry.relay : undefined;
	}

	has(slug: string): boolean {
		return this.entries.has(slug);
	}

	isReady(slug: string): boolean {
		return this.entries.get(slug)?.status === "ready";
	}

	findByDirectory(directory: string): ProjectEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.project.directory === directory) {
				return { ...entry, project: { ...entry.project } };
			}
		}
		return undefined;
	}

	allProjects(): ReadonlyArray<Readonly<StoredProject>> {
		return Array.from(this.entries.values())
			.map((e) => ({ ...e.project }))
			.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
	}

	readyEntries(): Array<[string, ProjectReady]> {
		const result: Array<[string, ProjectReady]> = [];
		for (const [slug, entry] of this.entries) {
			if (entry.status === "ready") {
				result.push([slug, entry]);
			}
		}
		return result;
	}

	slugs(): IterableIterator<string> {
		return this.entries.keys();
	}

	get size(): number {
		return this.entries.size;
	}

	// ── Cross-relay operations (D4) ─────────────────────────────────────

	/** Broadcast a message to all connected browser clients across all ready relays. */
	broadcastToAll(message: RelayMessage): void {
		for (const [, entry] of this.readyEntries()) {
			entry.relay.wsHandler.broadcast(message);
		}
	}

	/** Evict oldest cached sessions across all ready relays to free memory/disk. */
	evictOldestSessions(maxPerRelay: number): string[] {
		const evicted: string[] = [];
		for (const [, entry] of this.readyEntries()) {
			for (let i = 0; i < maxPerRelay; i++) {
				const sessionId = entry.relay.messageCache.evictOldestSession();
				if (sessionId === null) break;
				evicted.push(sessionId);
			}
		}
		return evicted;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	add(
		project: StoredProject,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): void {
		const { slug } = project;
		if (this.entries.has(slug)) {
			throw new Error(`Project "${slug}" is already registered`);
		}

		this.entries.set(slug, { status: "registering", project });
		this.emit("project_added", slug, project);

		const ac = new AbortController();
		this.abortControllers.set(slug, ac);

		this.tracked(
			createRelay(ac.signal).then(
				(relay) => {
					// If removed or replaced while creating, discard
					if (!this.abortControllers.has(slug) || ac.signal.aborted) {
						relay.stop().catch(() => {});
						return;
					}
					this.abortControllers.delete(slug);
					this.entries.set(slug, { status: "ready", project, relay });
					this.emit("project_ready", slug, relay);
				},
				(err) => {
					if (ac.signal.aborted) return; // Expected — remove() was called
					this.abortControllers.delete(slug);
					const message = err instanceof Error ? err.message : String(err);
					this.entries.set(slug, {
						status: "error",
						project,
						error: message,
					});
					this.emit("project_error", slug, message);
				},
			),
		);
	}

	addWithoutRelay(
		project: StoredProject,
		options?: { silent?: boolean },
	): void {
		const { slug } = project;
		if (this.entries.has(slug)) {
			throw new Error(`Project "${slug}" is already registered`);
		}
		this.entries.set(slug, { status: "registering", project });
		if (!options?.silent) {
			this.emit("project_added", slug, project);
		}
	}

	startRelay(
		slug: string,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): void {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}
		if (entry.status === "ready") {
			throw new Error(`Project "${slug}" already has a relay`);
		}

		// Reset to registering (from error state or existing registering)
		this.entries.set(slug, { status: "registering", project: entry.project });

		const ac = new AbortController();
		this.abortControllers.set(slug, ac);

		this.tracked(
			createRelay(ac.signal).then(
				(relay) => {
					if (!this.abortControllers.has(slug) || ac.signal.aborted) {
						relay.stop().catch(() => {});
						return;
					}
					this.abortControllers.delete(slug);
					this.entries.set(slug, {
						status: "ready",
						project: entry.project,
						relay,
					});
					this.emit("project_ready", slug, relay);
				},
				(err) => {
					if (ac.signal.aborted) return;
					this.abortControllers.delete(slug);
					const message = err instanceof Error ? err.message : String(err);
					this.entries.set(slug, {
						status: "error",
						project: entry.project,
						error: message,
					});
					this.emit("project_error", slug, message);
				},
			),
		);
	}

	async remove(slug: string): Promise<void> {
		const entry = this.entries.get(slug);
		if (!entry) return;

		// Abort any in-flight relay creation
		const ac = this.abortControllers.get(slug);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		// Stop relay if ready
		if (entry.status === "ready") {
			await entry.relay.stop();
		}

		this.entries.delete(slug);
		this.emit("project_removed", slug);
	}

	async replaceRelay(
		slug: string,
		createRelay: (signal: AbortSignal) => Promise<ProjectRelay>,
	): Promise<void> {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}

		// Abort any in-flight creation
		const ac = this.abortControllers.get(slug);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		// Stop current relay if ready
		if (entry.status === "ready") {
			await entry.relay.stop();
		}

		// Transition to registering and start new relay
		this.entries.set(slug, { status: "registering", project: entry.project });
		this.startRelay(slug, createRelay);
	}

	/**
	 * Bump the lastUsed timestamp for a project (e.g. on WS connect).
	 * Emits `project_updated` so the daemon can persist the new timestamp.
	 */
	touchLastUsed(slug: string): void {
		const entry = this.entries.get(slug);
		if (!entry) return;

		const updatedProject = { ...entry.project, lastUsed: Date.now() };

		if (entry.status === "ready") {
			this.entries.set(slug, {
				status: "ready",
				project: updatedProject,
				relay: entry.relay,
			});
		} else if (entry.status === "error") {
			this.entries.set(slug, {
				status: "error",
				project: updatedProject,
				error: entry.error,
			});
		} else {
			this.entries.set(slug, {
				status: "registering",
				project: updatedProject,
			});
		}

		this.emit("project_updated", slug, updatedProject);
	}

	updateProject(
		slug: string,
		updates: Partial<Pick<StoredProject, "title" | "instanceId">>,
	): void {
		const entry = this.entries.get(slug);
		if (!entry) {
			throw new Error(`Project "${slug}" not found`);
		}

		const updatedProject = { ...entry.project, ...updates };

		// Rebuild the entry with the same status but updated project
		if (entry.status === "ready") {
			this.entries.set(slug, {
				status: "ready",
				project: updatedProject,
				relay: entry.relay,
			});
		} else if (entry.status === "error") {
			this.entries.set(slug, {
				status: "error",
				project: updatedProject,
				error: entry.error,
			});
		} else {
			this.entries.set(slug, {
				status: "registering",
				project: updatedProject,
			});
		}

		this.emit("project_updated", slug, updatedProject);
	}

	// ── WS upgrade helper ───────────────────────────────────────────────

	waitForRelay(
		slug: string,
		timeoutMs = 10_000,
		signal?: AbortSignal,
	): Promise<ProjectRelay> {
		return this.tracked(
			new Promise((resolve, reject) => {
				const entry = this.entries.get(slug);

				if (!entry) {
					reject(new Error(`Project "${slug}" not found`));
					return;
				}
				if (entry.status === "ready") {
					resolve(entry.relay);
					return;
				}
				if (entry.status === "error") {
					reject(new Error(`Project "${slug}" relay failed: ${entry.error}`));
					return;
				}
				if (signal?.aborted) {
					reject(new Error(`Wait for relay "${slug}" was aborted`));
					return;
				}

				// status === "registering" — wait for resolution
				const cleanup = () => {
					this.off("project_ready", onReady);
					this.off("project_error", onError);
					this.off("project_removed", onRemoved);
					if (signal) signal.removeEventListener("abort", onAbort);
					clearTimeout(timer);
				};

				const onReady = (readySlug: string, relay: ProjectRelay) => {
					if (readySlug !== slug) return;
					cleanup();
					resolve(relay);
				};
				const onError = (errorSlug: string, error: string) => {
					if (errorSlug !== slug) return;
					cleanup();
					reject(new Error(`Project "${slug}" relay failed: ${error}`));
				};
				const onRemoved = (removedSlug: string) => {
					if (removedSlug !== slug) return;
					cleanup();
					reject(new Error(`Project "${slug}" was removed`));
				};
				const onAbort = () => {
					cleanup();
					reject(new Error(`Wait for relay "${slug}" was aborted`));
				};

				this.on("project_ready", onReady);
				this.on("project_error", onError);
				this.on("project_removed", onRemoved);
				if (signal) signal.addEventListener("abort", onAbort, { once: true });

				const timer = setTimeout(() => {
					cleanup();
					reject(
						new Error(`Timed out waiting for relay "${slug}" (${timeoutMs}ms)`),
					);
				}, timeoutMs);
			}),
		);
	}

	// ── Teardown ────────────────────────────────────────────────────────

	async stopAll(): Promise<void> {
		const stops: Promise<void>[] = [];

		for (const [slug, ac] of this.abortControllers) {
			ac.abort();
			this.abortControllers.delete(slug);
		}

		for (const [slug, entry] of this.entries) {
			if (entry.status === "ready") {
				stops.push(entry.relay.stop().catch(() => {}));
			}
			this.entries.delete(slug);
			this.emit("project_removed", slug);
		}

		await Promise.all(stops);
	}

	override async drain(): Promise<void> {
		await this.stopAll();
		await super.drain();
	}
}

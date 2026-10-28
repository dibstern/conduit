/** Unknown provenance stays addressed, but cannot authorize delivery. */
export type Audience =
	| {
			readonly _tag: "session";
			readonly sessionId: string;
			readonly projectId: string | undefined;
	  }
	| { readonly _tag: "project"; readonly projectId: string | undefined }
	| { readonly _tag: "global" }
	| {
			readonly _tag: "pty";
			readonly ptyId: string;
			readonly projectId: string | undefined;
	  };

export interface Interests {
	readonly sessions: ReadonlySet<string>;
	readonly projects: ReadonlySet<string>;
	/** PTY id to its attached Projects; ids alone are not cross-project authority. */
	readonly ptys: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The address of a browser event, independent of its transport envelope. */
export interface BrowserEvent {
	readonly type: string;
	readonly sessionId?: string | undefined;
	readonly projectId?: string | undefined;
	readonly ptyId?: string | undefined;
}

export const audienceOf = (
	event: BrowserEvent,
	projectOf: (sessionId: string) => string | undefined,
): Audience => {
	if (
		event.type === "global" ||
		event.type === "permission" ||
		event.type === "question"
	)
		return { _tag: "global" };
	if (event.ptyId !== undefined)
		return { _tag: "pty", ptyId: event.ptyId, projectId: event.projectId };
	if (event.sessionId !== undefined)
		return {
			_tag: "session",
			sessionId: event.sessionId,
			projectId: projectOf(event.sessionId),
		};
	return { _tag: "project", projectId: event.projectId };
};

export const delivers = (audience: Audience, interests: Interests): boolean => {
	if (audience._tag === "global") return true;
	if (
		audience.projectId === undefined ||
		!interests.projects.has(audience.projectId)
	)
		return false;
	switch (audience._tag) {
		case "session":
			return interests.sessions.has(audience.sessionId);
		case "pty":
			return (
				interests.ptys.get(audience.ptyId)?.has(audience.projectId) === true
			);
		case "project":
			return true;
	}
};

/** One connection's live views; independent scopes may hold the same interest. */
export class EventDelivery {
	private readonly views = new Set<Interests>();
	private readonly subscriptions = new Map<object, Interests>();
	private readonly selected = new Map<string, Interests>();
	private readonly listeners = new Set<() => void>();
	private readonly catalogues = new Map<object, ReadonlySet<string>>();
	private hasSelection = false;
	private closed = false;

	get interests(): Interests {
		const sessions = new Set<string>();
		const projects = new Set<string>();
		const ptys = new Map<string, Set<string>>();
		for (const view of [
			...this.views,
			...this.subscriptions.values(),
			...[...this.selected.values()].map((view) => this.allowed(view)),
		]) {
			for (const id of view.sessions) sessions.add(id);
			for (const id of view.projects) projects.add(id);
			for (const [id, attachedProjects] of view.ptys) {
				const owners = ptys.get(id) ?? new Set<string>();
				for (const project of attachedProjects) owners.add(project);
				ptys.set(id, owners);
			}
		}
		return { sessions, projects, ptys };
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	covers(audience: Audience): boolean {
		return !this.closed && delivers(audience, this.interests);
	}

	private allowed(interests: Interests): Interests {
		const catalogue =
			this.catalogues.size === 0
				? undefined
				: new Set(
						[...this.catalogues.values()].flatMap((projects) => [...projects]),
					);
		const selected = new Set(
			[...this.selected.values()].flatMap((view) => [...view.sessions]),
		);
		const projects = new Set(
			[...interests.projects].filter(
				(id) => catalogue === undefined || catalogue.has(id),
			),
		);
		return {
			sessions: new Set(
				[...interests.sessions].filter(
					(id) => !this.hasSelection || selected.has(id),
				),
			),
			projects,
			ptys: new Map(
				[...interests.ptys].map(([id, owners]) => [
					id,
					new Set([...owners].filter((owner) => projects.has(owner))),
				]),
			),
		};
	}

	/** Subscription grants can be revoked by the connection's current views. */
	subscription(interests: Interests): {
		update: (next: Interests, projectCatalogue?: boolean) => void;
		release: () => void;
	} {
		const identity = {};
		if (!this.closed) this.subscriptions.set(identity, this.allowed(interests));
		this.changed();
		return {
			update: (next, projectCatalogue = false) => {
				const previous = this.subscriptions.get(identity);
				if (previous === undefined || this.closed) return;
				this.subscriptions.set(identity, this.allowed(next));
				if (projectCatalogue) {
					this.catalogues.set(identity, next.projects);
					this.subscriptions.set(identity, this.allowed(next));
					for (const [key, view] of this.subscriptions) {
						this.subscriptions.set(key, this.allowed(view));
					}
				}
				this.changed();
			},
			release: () => {
				this.subscriptions.delete(identity);
				this.catalogues.delete(identity);
				this.changed();
			},
		};
	}

	view(interests: Interests): () => void {
		if (this.closed) return () => {};
		// Each registration has its own identity even when callers share a value.
		const view = { ...interests };
		this.views.add(view);
		this.changed();
		return () => {
			this.views.delete(view);
			this.changed();
		};
	}

	setClientSession(
		clientId: string,
		sessionId: string,
		projectId: string | undefined,
	): () => void {
		if (this.closed) return () => {};
		const selection = {
			sessions: new Set([sessionId]),
			projects: new Set(projectId === undefined ? [] : [projectId]),
			ptys: new Map<string, ReadonlySet<string>>(),
		};
		this.selected.set(clientId, selection);
		this.hasSelection = true;
		for (const [key, view] of this.subscriptions)
			this.subscriptions.set(key, this.allowed(view));
		this.changed();
		return () => {
			if (this.selected.get(clientId) === selection) {
				this.selected.delete(clientId);
				for (const [key, view] of this.subscriptions)
					this.subscriptions.set(key, this.allowed(view));
				this.changed();
			}
		};
	}

	deliver(
		event: BrowserEvent,
		projectOf: (sessionId: string) => string | undefined,
		send: () => void,
	): boolean {
		const audience = audienceOf(event, projectOf);
		if (this.closed || !delivers(audience, this.interests)) return false;
		send();
		return true;
	}

	close(): void {
		this.closed = true;
		this.views.clear();
		this.subscriptions.clear();
		this.catalogues.clear();
		this.selected.clear();
		this.changed();
		this.listeners.clear();
	}
}

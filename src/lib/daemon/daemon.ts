// ─── Daemon Process (Ticket 3.1) ────────────────────────────────────────────
// Background daemon that persists across terminal sessions. Manages the HTTP
// server, multiple projects, and communicates with CLI via Unix socket IPC.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { Server as NetServer, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthManager } from "../auth.js";
import {
	ensureCerts,
	getAllIPs,
	getTailscaleIP,
	type TlsCerts,
} from "../cli/tls.js";
import {
	DAEMON_SHUTDOWN_DELAY_MS,
	DEFAULT_OPENCODE_PORT,
	DEFAULT_OPENCODE_URL,
} from "../constants.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import { InstanceManager } from "../instance/instance-manager.js";
import {
	createLogger,
	type LogFormat,
	type Logger,
	type LogLevel,
	setLogFormat,
	setLogLevel,
} from "../logger.js";
import type { ProjectRelay } from "../relay/relay-stack.js";
import { RequestRouter } from "../server/http-router.js";
import type { PushNotificationManager } from "../server/push.js";
import type { OpenCodeInstance, StoredProject } from "../types.js";
import { generateSlug } from "../utils.js";
import {
	clearCrashInfo,
	type DaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
	syncRecentProjects,
} from "./config-persistence.js";
import { CrashCounter } from "./crash-counter.js";
import {
	closeHttpServer as closeHttpServerImpl,
	closeIPCServer as closeIPCServerImpl,
	closeOnboardingServer as closeOnboardingServerImpl,
	type DaemonLifecycleContext,
	startHttpServer as startHttpServerImpl,
	startIPCServer as startIPCServerImpl,
	startOnboardingServer as startOnboardingServerImpl,
} from "./daemon-lifecycle.js";
import {
	buildSpawnConfig as buildSpawnConfigImpl,
	spawnDaemon,
} from "./daemon-spawn.js";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
	probeOpenCodePort,
} from "./daemon-utils.js";
import { KeepAwake } from "./keep-awake.js";
import {
	cleanupStalePidFiles,
	removePidFile,
	removeSocketFile,
	writePidFile,
} from "./pid-manager.js";
import { PortScanner, type ScanResult } from "./port-scanner.js";
import { ProjectRegistry } from "./project-registry.js";
import {
	installSignalHandlers,
	removeSignalHandlers,
} from "./signal-handlers.js";
import { StorageMonitor } from "./storage-monitor.js";
import { VersionChecker } from "./version-check.js";

/**
 * Default frontend directory resolved relative to this file.
 * Compiled: dist/src/lib/daemon/daemon.js → 3×.. → dist/ → dist/frontend/
 * Dev (tsx): src/lib/daemon/daemon.ts → 3×.. → repo root → frontend/ (doesn't exist)
 * Falls back to cwd-based resolution for dev mode.
 */
const _candidate = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"frontend",
);
const DEFAULT_STATIC_DIR = existsSync(_candidate)
	? _candidate
	: join(process.cwd(), "dist", "frontend");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DaemonOptions {
	port?: number;
	/** Bind address for the HTTP server (default: "127.0.0.1"). Set to "0.0.0.0" to listen on all interfaces. */
	host?: string;
	configDir?: string;
	socketPath?: string;
	logPath?: string;
	pidPath?: string;
	pinHash?: string;
	tlsEnabled?: boolean;
	keepAwake?: boolean;
	/** OpenCode server URL (e.g., "http://localhost:4096") */
	opencodeUrl?: string;
	/** Override the static file directory (default: dist/frontend relative to cwd) */
	staticDir?: string;
	/**
	 * Enable smart default detection in start().
	 * When true (default) and no opencodeUrl is provided, probes localhost:4096
	 * to decide whether to connect as unmanaged or spawn as managed.
	 * Set to false in tests that don't want auto-detection.
	 */
	smartDefault?: boolean;
	/** Log level override (default: info). */
	logLevel?: LogLevel;
	/** Log format override (default: json for daemon, pretty for foreground). */
	logFormat?: LogFormat;
}

export interface DaemonStatus {
	ok: boolean;
	uptime: number;
	port: number;
	host: string;
	/** Tailscale IP if detected, for share URL construction. */
	tailscaleIP?: string;
	/** First LAN IP (non-Tailscale routable address), for share URL construction. */
	lanIP?: string;
	projectCount: number;
	clientCount: number;
	pinEnabled: boolean;
	tlsEnabled: boolean;
	keepAwake: boolean;
	projects: Array<{
		slug: string;
		directory: string;
		title: string;
		status?: string;
		lastUsed?: number;
	}>;
}

/** Spawn configuration built by buildSpawnConfig() — testable without mocking */
export interface SpawnConfig {
	execPath: string;
	args: string[];
	options: import("node:child_process").SpawnOptions;
}

// ─── Daemon ─────────────────────────────────────────────────────────────────

export class Daemon {
	port: number;
	private host: string;
	readonly configDir: string;
	readonly socketPath: string;
	readonly logPath: string;
	readonly pidPath: string;

	private httpServer: HttpServer | null = null;
	/** Inner HTTPS server for WebSocket upgrades when protocol detection is active. */
	private upgradeServer: HttpServer | null = null;
	private onboardingServer: HttpServer | null = null;
	private ipcServer: NetServer | null = null;
	private ipcClients: Set<Socket> = new Set();
	/**
	 * Project registry — intentionally public (not private) so tests and
	 * lifecycle helpers can inspect project/relay state without exposing
	 * dedicated getter methods for every query.
	 */
	readonly registry = new ProjectRegistry();
	private startTime: number = Date.now();
	private clientCount = 0;
	private shuttingDown = false;

	// Enhanced daemon fields (Ticket 8.7)
	private pinHash: string | null;
	private readonly auth: AuthManager;
	private tlsEnabled: boolean;
	private keepAwake: boolean;
	private readonly smartDefault: boolean;
	private tlsCerts: TlsCerts | null = null;
	/** True when host was explicitly provided via options (not auto-defaulted). */
	private readonly hostExplicit: boolean;

	// Relay integration
	private readonly instanceManager: InstanceManager;
	private readonly staticDir: string;
	private pushManager: PushNotificationManager | null = null;

	// Version checker (Ticket 3.4)
	private versionChecker: VersionChecker | null = null;

	// Keep-awake manager (Ticket 3.5)
	private keepAwakeManager: KeepAwake | null = null;

	// Storage monitor (Ticket 6.2 AC8)
	private storageMonitor: StorageMonitor | null = null;

	// Port scanner for auto-discovery
	private scanner: PortScanner | null = null;

	// HTTP request router
	private router: RequestRouter | null = null;

	// Crash counter
	private readonly crashCounter = new CrashCounter();

	// Structured logger
	private readonly log: Logger = createLogger("daemon");

	constructor(options?: DaemonOptions) {
		const configDir = options?.configDir ?? DEFAULT_CONFIG_DIR;
		this.port = options?.port ?? DEFAULT_PORT;
		this.hostExplicit = options?.host != null;
		this.host = options?.host ?? "127.0.0.1";
		this.configDir = configDir;
		this.socketPath = options?.socketPath ?? join(configDir, "relay.sock");
		this.logPath = options?.logPath ?? join(configDir, "daemon.log");
		this.pidPath = options?.pidPath ?? join(configDir, "daemon.pid");
		this.pinHash = options?.pinHash ?? null;
		this.auth = new AuthManager();
		if (this.pinHash) {
			this.auth.setPinHash(this.pinHash);
		}
		this.tlsEnabled = options?.tlsEnabled ?? false;
		this.keepAwake = options?.keepAwake ?? false;
		this.smartDefault = options?.smartDefault ?? true;
		this.instanceManager = new InstanceManager();

		// Auto-persist config on project mutations
		this.registry.on("project_added", () => this.persistConfig());
		this.registry.on("project_ready", () => this.persistConfig());
		this.registry.on("project_updated", () => this.persistConfig());
		this.registry.on("project_removed", () => {
			// Skip auto-persist during shutdown — stop() already saved final config
			// before calling stopAll(), and the registry is being torn down.
			if (!this.shuttingDown) this.persistConfig();
		});

		// Log state transitions
		this.registry.on("project_added", (slug) =>
			this.log.info({ slug }, "Project registered"),
		);
		this.registry.on("project_ready", (slug) =>
			this.log.info({ slug }, "Project relay ready"),
		);
		this.registry.on("project_error", (slug, error) =>
			this.log.warn({ slug, error }, "Project relay failed"),
		);
		this.registry.on("project_removed", (slug) =>
			this.log.info({ slug }, "Project removed"),
		);

		// Inject auth-aware health checker so health polls authenticate with
		// OpenCode's Basic Auth when OPENCODE_SERVER_PASSWORD is set.
		// Supports per-instance passwords: instance.env.OPENCODE_SERVER_PASSWORD
		// takes precedence over the global process.env.OPENCODE_SERVER_PASSWORD.
		//
		// Read directly from process.env (not ENV) because ENV captures values
		// at module load time, but the daemon constructor may run after env vars
		// are set (e.g. in tests or dynamic configuration).
		const globalPassword = process.env["OPENCODE_SERVER_PASSWORD"];
		const globalUsername =
			process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";

		this.instanceManager.setHealthChecker(
			async (port: number, instance: OpenCodeInstance) => {
				const password =
					instance.env?.["OPENCODE_SERVER_PASSWORD"] ?? globalPassword;
				if (!password) {
					// No auth configured — bare health check
					try {
						const res = await fetch(`http://localhost:${port}/health`);
						return res.ok;
					} catch {
						return false;
					}
				}
				const username =
					instance.env?.["OPENCODE_SERVER_USERNAME"] ?? globalUsername;
				const encoded = Buffer.from(`${username}:${password}`).toString(
					"base64",
				);
				try {
					const res = await fetch(`http://localhost:${port}/health`, {
						headers: {
							Authorization: `Basic ${encoded}`,
						},
					});
					return res.ok;
				} catch {
					return false;
				}
			},
		);

		// Broadcast instance status changes to all connected browser clients
		this.instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
			this.registry.broadcastToAll({
				type: "instance_status",
				instanceId: instance.id,
				status: instance.status,
			});
		});

		// Backward compatibility: create "default" instance from opencodeUrl
		const initialUrl = options?.opencodeUrl ?? null;
		if (initialUrl) {
			const urlPort = (() => {
				try {
					return new URL(initialUrl).port;
				} catch {
					return "";
				}
			})();
			const port = urlPort ? parseInt(urlPort, 10) : DEFAULT_OPENCODE_PORT;
			this.instanceManager.addInstance("default", {
				name: "Default",
				port,
				managed: false,
				url: initialUrl,
			});
		}

		this.staticDir = options?.staticDir ?? DEFAULT_STATIC_DIR;

		// Apply log configuration before any logging occurs
		if (options?.logLevel) setLogLevel(options.logLevel);
		if (options?.logFormat) setLogFormat(options.logFormat);
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/** Start the daemon: HTTP server + IPC socket + signal handlers */
	async start(): Promise<void> {
		// Ensure config directory exists
		if (!existsSync(this.configDir)) {
			mkdirSync(this.configDir, { recursive: true });
		}

		// Record crash for crash-counter tracking
		this.crashCounter.record();

		// Check crash counter
		if (this.crashCounter.shouldGiveUp()) {
			throw new Error(
				"Daemon crashed too many times within crash window — giving up",
			);
		}

		// Write PID file
		writePidFile(this.configDir, this.pidPath);

		// Rehydrate instances from persisted config (so relays can pick them up
		// before HTTP/IPC servers start).
		const savedConfig = loadDaemonConfig(this.configDir);
		if (savedConfig?.instances) {
			for (const inst of savedConfig.instances) {
				const existing = this.instanceManager.getInstance(inst.id);
				if (existing) {
					// Apply saved name to constructor-created instances (e.g. "default")
					if (inst.name && inst.name !== existing.name) {
						try {
							this.instanceManager.updateInstance(inst.id, {
								name: inst.name,
							});
						} catch {
							// Non-fatal — keep constructor name
						}
					}
					continue;
				}
				try {
					this.instanceManager.addInstance(inst.id, {
						name: inst.name,
						port: inst.port,
						managed: inst.managed,
						...(inst.env != null && { env: inst.env }),
						...(inst.url != null && { url: inst.url }),
					});
				} catch (err) {
					// Log unexpected errors (e.g. maxInstances exceeded) but don't crash startup
					this.log.warn(
						`Failed to rehydrate instance "${inst.id}":`,
						formatErrorDetail(err),
					);
				}
			}
		}

		// Rehydrate projects from persisted config (so they survive daemon restarts).
		if (savedConfig?.projects) {
			for (const proj of savedConfig.projects) {
				if (!proj.path || !proj.slug) continue;
				// Skip if already registered
				if (this.registry.has(proj.slug)) continue;
				const project: StoredProject = {
					slug: proj.slug,
					directory: proj.path,
					title: proj.title ?? proj.slug,
					lastUsed: proj.addedAt ?? Date.now(),
					...(proj.instanceId != null && { instanceId: proj.instanceId }),
				};
				this.registry.addWithoutRelay(project, { silent: true });
			}
			if (this.registry.size > 0) {
				this.log.info(
					`Rehydrated ${this.registry.size} project(s) from saved config`,
				);
			}
		}

		// ── Probe-and-convert: if the "default" instance was created as
		// unmanaged (via opencodeUrl from CLI), check whether it's actually
		// reachable.  If not, convert to managed so we auto-spawn OpenCode.
		const existingDefault = this.instanceManager.getInstance("default");
		if (this.smartDefault && existingDefault && !existingDefault.managed) {
			const url = `http://localhost:${existingDefault.port}`;
			const reachable = await probeOpenCode(url);

			if (!reachable) {
				if (!isOpencodeInstalled()) {
					throw new Error(
						`OpenCode is not running at ${url} and the "opencode" binary ` +
							"was not found on PATH.\n" +
							"Install OpenCode first: https://opencode.ai\n" +
							"Or start it manually: opencode serve --port " +
							`${existingDefault.port}`,
					);
				}
				// Convert to managed — remove and re-add
				const { name, port: originalPort } = existingDefault;
				this.instanceManager.removeInstance("default");
				const port = await findFreePort(originalPort);
				this.instanceManager.addInstance("default", {
					name,
					port,
					managed: true,
				});
				this.log.info(
					`OpenCode not reachable at ${url} — will spawn managed instance on port ${port}`,
				);
			}
		}

		// Smart default: if no "default" instance exists (neither from constructor
		// opencodeUrl nor from rehydrated config), probe localhost:4096 to decide
		// whether to connect as unmanaged or spawn as managed.
		if (this.smartDefault && !this.instanceManager.getInstance("default")) {
			const probeUrl = DEFAULT_OPENCODE_URL;
			const reachable = await probeOpenCode(probeUrl);

			if (reachable) {
				// OpenCode is already running — connect as unmanaged
				this.instanceManager.addInstance("default", {
					name: "Default",
					port: DEFAULT_OPENCODE_PORT,
					managed: false,
					url: probeUrl,
				});
				this.log.info(
					"Detected running OpenCode at localhost:4096 — connecting as unmanaged",
				);
			} else {
				// OpenCode not running — spawn as managed
				if (!isOpencodeInstalled()) {
					throw new Error(
						`OpenCode is not running at ${probeUrl} and the "opencode" ` +
							"binary was not found on PATH.\n" +
							"Install OpenCode first: https://opencode.ai\n" +
							`Or start it manually: opencode serve --port ${DEFAULT_OPENCODE_PORT}`,
					);
				}
				const port = await findFreePort(DEFAULT_OPENCODE_PORT);
				this.instanceManager.addInstance("default", {
					name: "Default",
					port,
					managed: true,
				});
				this.log.info(
					`No OpenCode detected — will spawn managed instance on port ${port}`,
				);
			}
		}

		// Auto-start managed default instance (if it was just created by smart
		// detection or rehydrated from config). Non-fatal if it fails.
		const defaultInst = this.instanceManager.getInstance("default");
		if (defaultInst?.managed && defaultInst.status === "stopped") {
			try {
				await this.instanceManager.startInstance("default");
			} catch (err) {
				this.log.warn(
					"Failed to auto-start default instance:",
					formatErrorDetail(err),
				);
			}
		}

		// Initialize push notification manager (non-fatal if it fails)
		try {
			const { PushNotificationManager } = await import("../server/push.js");
			this.pushManager = new PushNotificationManager({
				configDir: this.configDir,
			});
			await this.pushManager.init();
		} catch (err) {
			this.log.warn("Push notifications unavailable:", formatErrorDetail(err));
			this.pushManager = null;
		}

		// Load TLS certificates when TLS is enabled.
		// ensureCerts auto-generates via mkcert if available; falls back to HTTP if not.
		if (this.tlsEnabled) {
			try {
				this.tlsCerts = await ensureCerts({ configDir: this.configDir });
				if (!this.tlsCerts) {
					this.log.warn(
						"TLS enabled but mkcert not available — falling back to HTTP",
					);
					this.tlsEnabled = false;
				} else if (!this.hostExplicit) {
					// With TLS, bind to all interfaces so the daemon is accessible
					// over Tailscale / LAN (the cert covers all routable IPs).
					this.host = "0.0.0.0";
				}
			} catch (err) {
				this.log.warn(
					"TLS cert loading failed — falling back to HTTP:",
					formatErrorDetail(err),
				);
				this.tlsEnabled = false;
			}
		}

		// Create HTTP request router
		this.router = new RequestRouter({
			auth: this.auth,
			staticDir: this.staticDir,
			getProjects: () => {
				// Use allProjects() for consistent lastUsed-descending sort order
				return this.registry.allProjects().map((project) => {
					// biome-ignore lint/style/noNonNullAssertion: safe — slug comes from registry
					const entry = this.registry.get(project.slug)!;
					const relay = entry.status === "ready" ? entry.relay : undefined;
					return {
						slug: project.slug,
						directory: project.directory,
						title: project.title,
						status: entry.status,
						...(entry.status === "error" && { error: entry.error }),
						clients: relay?.wsHandler.getClientCount() ?? 0,
						sessions: relay?.messageCache.sessionCount() ?? 0,
						isProcessing: relay?.isAnySessionProcessing() ?? false,
					} satisfies import("../server/http-router.js").RouterProject;
				});
			},
			port: this.port,
			isTls: this.tlsEnabled,
			...(this.pushManager != null && { pushManager: this.pushManager }),
			...(this.tlsCerts?.caRoot != null && {
				caRootPath: this.tlsCerts.caRoot,
			}),
			...(this.tlsCerts?.caCertDer != null && {
				caCertDer: this.tlsCerts.caCertDer,
			}),
			authExemptPaths: [
				"/setup",
				"/health",
				"/api/status",
				"/api/setup-info",
				"/api/themes",
			],
			getHealthResponse: () => this.getStatus(),
		});

		// Start HTTP server
		await this.startHttpServer();

		// Start HTTP onboarding server on port+1 when TLS is active
		if (this.tlsEnabled) {
			await this.startOnboardingServer();
		}

		// WebSocket upgrade router — routes /p/{slug}/ws to the correct relay's WSS.
		// Must be registered after HTTP server starts but before any relays are added.
		// When protocol detection is active, upgrades fire on the inner HTTPS server.
		const wsServer = this.upgradeServer ?? this.httpServer;
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized by startHttpServer above
		wsServer!.on("upgrade", async (req, socket, head) => {
			const match = req.url?.match(/^\/p\/([^/]+)\/ws(?:\?|$)/);
			if (!match) {
				this.log.debug(
					{ url: req.url },
					"WS upgrade rejected: URL does not match /p/{slug}/ws",
				);
				socket.destroy();
				return;
			}
			// biome-ignore lint/style/noNonNullAssertion: safe — regex capture group exists when match is truthy
			const slug = match[1]!;

			// Auth gate — check before waiting for relay (fail fast on bad credentials)
			// biome-ignore lint/style/noNonNullAssertion: safe — router initialized before relays
			if (this.auth.hasPin() && !this.router!.checkAuth(req)) {
				this.log.warn({ slug }, "WS upgrade rejected: auth failed");
				socket.destroy();
				return;
			}

			try {
				const relay = await this.registry.waitForRelay(slug, 10_000);
				if (socket.destroyed || this.shuttingDown) {
					if (!socket.destroyed) socket.destroy();
					return;
				}
				this.log.debug({ slug }, "WS upgrade accepted");
				this.registry.touchLastUsed(slug);
				relay.wsHandler.handleUpgrade(req, socket, head);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				this.log.warn(
					{ slug, error: formatErrorDetail(err) },
					`WS upgrade rejected: ${errMsg}`,
				);
				if (!socket.destroyed) {
					if (socket.writable) {
						socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
					}
					socket.destroy();
				}
			}
		});

		// ── Port scanner for auto-discovery ──
		// Scans ports 4096–4110 every 30s for running OpenCode instances.
		// Discovered instances are auto-registered as unmanaged.
		// Lost instances (gone for 3 consecutive scans) are auto-removed if unmanaged.
		// NOTE: Scanner must be created BEFORE starting rehydrated relays so that
		// buildRelayFactory closures see this.scanner when they evaluate lazily.
		this.scanner = new PortScanner(
			{
				portRange: [4096, 4110],
				intervalMs: 30_000,
				probeTimeoutMs: 2000,
				removalThreshold: 3,
			},
			(port) => probeOpenCodePort(port),
		);

		// Exclude ports already occupied by managed instances
		const managedPorts = new Set(
			this.instanceManager
				.getInstances()
				.filter((i) => i.managed)
				.map((i) => i.port),
		);
		this.scanner.excludePorts(managedPorts);

		this.scanner.on("scan", (result: ScanResult) => {
			for (const port of result.discovered) {
				// Skip if an instance already occupies this port
				const existing = this.instanceManager
					.getInstances()
					.find((i) => i.port === port);
				if (existing) continue;

				const id = `discovered-${port}`;
				try {
					this.instanceManager.addInstance(id, {
						name: `OpenCode :${port}`,
						port,
						managed: false,
					});
					this.log.info(`Auto-discovered OpenCode instance on port ${port}`);
				} catch (err) {
					// Max instances or other error — non-fatal
					this.log.warn(
						`Failed to register discovered instance on port ${port}:`,
						formatErrorDetail(err),
					);
				}
			}

			for (const port of result.lost) {
				const instance = this.instanceManager
					.getInstances()
					.find((i) => i.port === port && !i.managed);
				if (instance) {
					try {
						this.instanceManager.removeInstance(instance.id);
						this.log.info(
							`Removed lost instance "${instance.id}" (port ${port})`,
						);
					} catch {
						// Already removed — ignore
					}
				}
			}

			// Broadcast updated instance list to all clients
			if (result.discovered.length > 0 || result.lost.length > 0) {
				const instances = this.instanceManager.getInstances();
				this.registry.broadcastToAll({ type: "instance_list", instances });
			}
		});

		this.scanner.start();
		// Run initial scan immediately
		void this.scanner.scan();

		// Start relays for rehydrated projects (HTTP + WS upgrade handler are
		// ready, so startRelay can attach). Non-fatal per project.
		for (const slug of this.registry.slugs()) {
			// biome-ignore lint/style/noNonNullAssertion: safe — slug comes from registry.slugs()
			const entry = this.registry.get(slug)!;
			if (entry.status === "ready") continue;
			const opencodeUrl = this.resolveOpencodeUrl(entry.project.instanceId);
			if (opencodeUrl) {
				this.registry.startRelay(
					slug,
					this.buildRelayFactory(entry.project, opencodeUrl),
				);
			}
		}

		// Retry relays for projects stuck in "registering" when an instance
		// becomes available (e.g. resolveOpencodeUrl returned null above because
		// the managed instance hadn't started yet).
		this.instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
			if (instance.status !== "healthy") return;
			for (const slug of this.registry.slugs()) {
				// biome-ignore lint/style/noNonNullAssertion: safe — slug comes from registry.slugs()
				const entry = this.registry.get(slug)!;
				if (entry.status !== "registering") continue;
				const opencodeUrl = this.resolveOpencodeUrl(entry.project.instanceId);
				if (opencodeUrl) {
					this.log.info(
						{ slug, instanceId: instance.id },
						"Instance became healthy — starting relay for registering project",
					);
					this.registry.startRelay(
						slug,
						this.buildRelayFactory(entry.project, opencodeUrl),
					);
				}
			}
		});

		// Start IPC server
		await this.startIPCServer();

		// Install signal handlers
		installSignalHandlers(() => {
			this.stop();
		});

		// Mark start time (resets crash window on success)
		this.startTime = Date.now();

		// Discover projects from OpenCode (non-blocking) so the dashboard
		// is populated even if daemon.json had no saved projects.
		void this.discoverProjects().catch((err) => {
			this.log.warn(
				"Failed to discover projects on startup:",
				formatErrorDetail(err),
			);
		});

		// Clear any previous crash info and save config (Ticket 8.7)
		clearCrashInfo(this.configDir);
		saveDaemonConfig(this.buildConfig(), this.configDir);

		// Start version checker (non-fatal if it fails)
		this.versionChecker = new VersionChecker({
			enabled: !process.argv.includes("--no-update"),
		});
		this.versionChecker.on("update_available", ({ latest }) => {
			// Broadcast to all connected browsers
			this.registry.broadcastToAll({
				type: "update_available",
				version: latest,
			});
		});
		this.versionChecker.start();

		// Initialize keep-awake (macOS caffeinate)
		this.keepAwakeManager = new KeepAwake({
			enabled: this.keepAwake,
		});

		// Start storage monitor (Ticket 6.2 AC8)
		const firstProject = this.getProjects()[0];
		this.storageMonitor = new StorageMonitor({
			path: firstProject?.directory ?? process.cwd(),
		});
		this.storageMonitor.on(
			"low_disk_space",
			({ availableBytes, thresholdBytes }) => {
				this.log.warn(
					`Low disk space warning: ${availableBytes / 1024 / 1024}MB available (threshold: ${thresholdBytes / 1024 / 1024}MB)`,
				);

				// Evict cached sessions to free memory/disk (up to 3 per relay)
				const evicted = this.registry.evictOldestSessions(3);
				for (const id of evicted) {
					this.log.info(`Evicted cached session "${id}" to free disk space`);
				}
			},
		);
		this.storageMonitor.on("disk_space_ok", ({ availableBytes }) => {
			this.log.info(
				`Disk space recovered: ${availableBytes / 1024 / 1024}MB available`,
			);
		});
		this.storageMonitor.start();
	}

	/** Gracefully stop the daemon */
	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		// Remove signal handlers
		removeSignalHandlers();

		// Stop version checker
		this.versionChecker?.stop();
		this.versionChecker = null;

		// Stop keep-awake
		this.keepAwakeManager?.deactivate();
		this.keepAwakeManager = null;

		// Stop storage monitor
		this.storageMonitor?.stop();
		this.storageMonitor = null;

		// Stop port scanner
		this.scanner?.stop();
		this.scanner = null;

		// Persist final config so instances survive restart (Fix #11)
		saveDaemonConfig(this.buildConfig(), this.configDir);

		// Stop all relay pipelines via registry
		await this.registry.stopAll();

		// Stop all managed OpenCode instances
		this.instanceManager.stopAll();

		// Close IPC clients
		for (const client of this.ipcClients) {
			try {
				client.destroy();
			} catch (err) {
				this.log.warn(`Error destroying IPC client during shutdown: ${err}`);
			}
		}
		this.ipcClients.clear();

		// Close IPC server
		await this.closeIPC();

		// Close onboarding server
		await this.closeOnboarding();

		// Close HTTP server
		await this.closeHttp();

		// Remove PID file
		removePidFile(this.pidPath);

		// Remove socket file
		removeSocketFile(this.socketPath);

		this.shuttingDown = false;
	}

	// ─── Project management ─────────────────────────────────────────────────

	/** Add a project, generating a slug if needed */
	async addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<StoredProject> {
		// Expand ~ to home directory
		if (directory.startsWith("~/") || directory === "~") {
			directory = directory.replace(/^~/, homedir());
		}
		// Normalize to absolute path with no trailing slash
		directory = resolve(directory);

		// Check if directory is already registered
		const existing = this.registry.findByDirectory(directory);
		if (existing) {
			return existing.project;
		}

		const existingSlugs = new Set(this.registry.slugs());
		const resolvedSlug = slug ?? generateSlug(directory, existingSlugs);
		const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
		const title = parts[parts.length - 1] ?? "project";

		// Resolve instance: explicit > first healthy > first available > undefined
		const resolvedInstanceId =
			instanceId ??
			this.instanceManager.getInstances().find((i) => i.status === "healthy")
				?.id ??
			this.instanceManager.getInstances()[0]?.id;

		const project: StoredProject = {
			slug: resolvedSlug,
			directory,
			title,
			lastUsed: Date.now(),
			...(resolvedInstanceId != null && { instanceId: resolvedInstanceId }),
		};

		// Start relay pipeline for this project if OpenCode is available
		const opencodeUrl = this.resolveOpencodeUrl(project.instanceId);
		if (opencodeUrl && this.httpServer) {
			this.registry.add(project, this.buildRelayFactory(project, opencodeUrl));
		} else {
			this.registry.addWithoutRelay(project);
		}

		// Sync recent projects
		syncRecentProjects(
			this.getProjects().map((p) => ({
				path: p.directory,
				slug: p.slug,
				title: p.title,
			})),
			this.configDir,
		);

		return project;
	}

	/** Remove a project by slug */
	async removeProject(slug: string): Promise<void> {
		if (!this.registry.has(slug)) {
			throw new Error(`Project "${slug}" not found`);
		}
		await this.registry.remove(slug);

		// Sync recent projects
		syncRecentProjects(
			this.getProjects().map((p) => ({
				path: p.directory,
				slug: p.slug,
				title: p.title,
			})),
			this.configDir,
		);
	}

	/** Get all registered projects */
	getProjects(): ReadonlyArray<Readonly<StoredProject>> {
		return this.registry.allProjects();
	}

	/** Get all registered OpenCode instances */
	getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>> {
		return this.instanceManager.getInstances();
	}

	/** Get the port scanner (for scan_now handler). */
	getScanner(): PortScanner | null {
		return this.scanner;
	}

	/**
	 * Switch a project's instance binding and rebuild its relay.
	 * Stops the old relay (if any), resolves the new instance URL, and creates
	 * a fresh relay connected to the new OpenCode server.
	 */
	async setProjectInstance(slug: string, instanceId: string): Promise<void> {
		this.registry.updateProject(slug, { instanceId });

		// biome-ignore lint/style/noNonNullAssertion: safe — updateProject just succeeded
		const project = this.registry.getProject(slug)!;
		const opencodeUrl = this.resolveOpencodeUrl(instanceId);
		if (opencodeUrl) {
			await this.registry.replaceRelay(
				slug,
				this.buildRelayFactory(project, opencodeUrl),
			);
		}
	}

	/**
	 * Discover and register projects from OpenCode's /project API.
	 * Non-fatal: logs errors but doesn't throw.
	 */
	async discoverProjects(): Promise<void> {
		const discoveryUrl = this.resolveOpencodeUrl();
		if (!discoveryUrl) return;

		const discoveryLog = createLogger("relay").child("discovery");

		try {
			const { OpenCodeClient } = await import("../instance/opencode-client.js");
			const client = new OpenCodeClient({ baseUrl: discoveryUrl });
			const projects = await client.listProjects();

			let added = 0;
			for (const p of projects) {
				const dir = p.worktree ?? p.path;
				if (dir && dir !== "/") {
					try {
						const sizeBefore = this.registry.size;
						await this.addProject(dir);
						if (this.registry.size > sizeBefore) added++;
					} catch {
						// Non-fatal: individual project registration failure
					}
				}
			}

			// Retry error-state projects — their relay may have failed transiently
			for (const slug of this.registry.slugs()) {
				// biome-ignore lint/style/noNonNullAssertion: safe — slug comes from registry.slugs()
				const entry = this.registry.get(slug)!;
				if (entry.status !== "error") continue;
				const opencodeUrl = this.resolveOpencodeUrl(entry.project.instanceId);
				if (opencodeUrl) {
					this.registry.startRelay(
						slug,
						this.buildRelayFactory(entry.project, opencodeUrl),
					);
					discoveryLog.info({ slug }, "Retrying relay for error-state project");
				}
			}

			discoveryLog.info(
				`Discovered ${projects.length} project(s) from OpenCode, registered ${added}`,
			);
		} catch (err) {
			discoveryLog.warn(
				"Failed to discover projects from OpenCode:",
				formatErrorDetail(err),
			);
		}
	}

	// ─── Status ─────────────────────────────────────────────────────────────

	/** Get daemon status */
	getStatus(): DaemonStatus {
		const tsIP = getTailscaleIP();
		const allIPs = getAllIPs();
		const lanIP = allIPs.find((ip) => !ip.startsWith("100.")) ?? null;
		return {
			ok: true,
			uptime: (Date.now() - this.startTime) / 1000,
			port: this.port,
			host: this.host,
			...(tsIP != null && { tailscaleIP: tsIP }),
			...(lanIP != null && { lanIP }),
			projectCount: this.registry.size,
			clientCount: this.clientCount,
			pinEnabled: this.pinHash !== null,
			tlsEnabled: this.tlsEnabled,
			keepAwake: this.keepAwake,
			projects: Array.from(this.registry.slugs()).map((slug) => {
				// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.slugs(), entry is guaranteed
				const entry = this.registry.get(slug)!;
				return {
					slug,
					directory: entry.project.directory,
					title: entry.project.title,
					status: entry.status,
					...(entry.project.lastUsed != null && {
						lastUsed: entry.project.lastUsed,
					}),
				};
			}),
		};
	}

	// ─── Private: Helper methods ────────────────────────────────────────────

	private resolveOpencodeUrl(instanceId?: string): string | null {
		if (!instanceId) {
			// Fall back to first available instance
			const instances = this.instanceManager.getInstances();
			if (instances.length === 0) return null;
			try {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				return this.instanceManager.getInstanceUrl(instances[0]!.id);
			} catch {
				this.log.debug(
					"Failed to resolve OpenCode URL for first available instance",
				);
				return null;
			}
		}
		try {
			return this.instanceManager.getInstanceUrl(instanceId);
		} catch {
			this.log.debug(
				{ instanceId },
				"Failed to resolve OpenCode URL for instance",
			);
			return null;
		}
	}

	private buildRelayFactory(
		project: StoredProject,
		opencodeUrl: string,
	): (signal: AbortSignal) => Promise<ProjectRelay> {
		return async (signal: AbortSignal) => {
			const { createProjectRelay } = await import("../relay/relay-stack.js");
			return createProjectRelay({
				// biome-ignore lint/style/noNonNullAssertion: safe — only called when httpServer is available
				httpServer: this.httpServer!,
				opencodeUrl,
				projectDir: project.directory,
				slug: project.slug,
				noServer: true,
				signal,
				log: createLogger("relay"),
				getProjects: () => this.getProjects(),
				addProject: async (dir: string) => {
					const p = await this.addProject(dir);
					return {
						slug: p.slug,
						title: p.title,
						directory: p.directory,
						...(p.instanceId != null && { instanceId: p.instanceId }),
					};
				},
				removeProject: async (slug: string) => {
					await this.removeProject(slug);
				},
				setProjectTitle: (slug: string, title: string) => {
					this.registry.updateProject(slug, { title });
					this.persistConfig();
				},
				getInstances: () => this.getInstances(),
				addInstance: (id, config) =>
					this.instanceManager.addInstance(id, config),
				removeInstance: (id) => this.instanceManager.removeInstance(id),
				startInstance: (id) => this.instanceManager.startInstance(id),
				stopInstance: (id) => this.instanceManager.stopInstance(id),
				updateInstance: (id, updates) =>
					this.instanceManager.updateInstance(id, updates),
				persistConfig: () => this.persistConfig(),
				...(this.scanner != null && {
					triggerScan: () => {
						if (!this.scanner) throw new Error("Scanner no longer available");
						return this.scanner.scan();
					},
				}),
				setProjectInstance: (slug: string, instanceId: string) =>
					this.setProjectInstance(slug, instanceId),
				...(this.pushManager != null && { pushManager: this.pushManager }),
				configDir: this.configDir,
			});
		};
	}

	private persistConfig(): void {
		saveDaemonConfig(this.buildConfig(), this.configDir);
	}

	// ─── Private: Context adapters ─────────────────────────────────────────

	/** Mutable context adapter for lifecycle functions (get/set backed by this). */
	private asLifecycleContext(): DaemonLifecycleContext {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		return {
			get port() {
				return self.port;
			},
			set port(v: number) {
				self.port = v;
			},
			get host() {
				return self.host;
			},
			get httpServer() {
				return self.httpServer;
			},
			set httpServer(v) {
				self.httpServer = v;
			},
			get upgradeServer() {
				return self.upgradeServer;
			},
			set upgradeServer(v) {
				self.upgradeServer = v;
			},
			get onboardingServer() {
				return self.onboardingServer;
			},
			set onboardingServer(v) {
				self.onboardingServer = v;
			},
			get ipcServer() {
				return self.ipcServer;
			},
			set ipcServer(v) {
				self.ipcServer = v;
			},
			ipcClients: this.ipcClients,
			get clientCount() {
				return self.clientCount;
			},
			set clientCount(v: number) {
				self.clientCount = v;
			},
			socketPath: this.socketPath,
			get router() {
				return self.router;
			},
			...(this.tlsCerts != null && {
				tls: {
					key: this.tlsCerts.key,
					// Include CA root in cert chain so clients receive the full chain
					// during TLS handshake (helps iOS and other strict TLS clients).
					cert: this.tlsCerts.caCertPem
						? Buffer.concat([
								this.tlsCerts.cert,
								Buffer.from("\n"),
								this.tlsCerts.caCertPem,
							])
						: this.tlsCerts.cert,
				},
			}),
		};
	}

	// ─── Private: Config building (Ticket 8.7) ─────────────────────────────

	private buildConfig(): DaemonConfig {
		return {
			pid: process.pid,
			port: this.port,
			pinHash: this.pinHash,
			tls: this.tlsEnabled,
			debug: false,
			keepAwake: this.keepAwake,
			dangerouslySkipPermissions: false,
			projects: this.getProjects().map((p) => ({
				path: p.directory,
				slug: p.slug,
				title: p.title,
				addedAt: p.lastUsed ?? Date.now(),
				...(p.instanceId != null && { instanceId: p.instanceId }),
			})),
			instances: this.instanceManager.getInstances().map((inst) => {
				const extUrl = this.instanceManager.getExternalUrl(inst.id);
				return {
					id: inst.id,
					name: inst.name,
					port: inst.port,
					managed: inst.managed,
					...(inst.env != null && { env: inst.env }),
					...(extUrl != null && { url: extUrl }),
				};
			}),
		};
	}

	// ─── Static methods ─────────────────────────────────────────────────────

	/** Check if a daemon is already running */
	static async isRunning(socketPath?: string): Promise<boolean> {
		const resolvedSocketPath =
			socketPath ?? join(DEFAULT_CONFIG_DIR, "relay.sock");
		const pidPath = resolvedSocketPath.replace(/relay\.sock$/, "daemon.pid");

		// Check PID file
		let pid: number | null = null;
		try {
			const content = readFileSync(pidPath, "utf-8").trim();
			pid = Number.parseInt(content, 10);
		} catch {
			// No PID file — try socket directly (PID file may have been
			// cleaned up while the daemon is still running)
		}

		if (pid !== null && !Number.isNaN(pid)) {
			// Check if PID is alive
			try {
				process.kill(pid, 0);
			} catch {
				// Process doesn't exist — stale
				cleanupStalePidFiles(pidPath, resolvedSocketPath);
				return false;
			}
		}

		// Verify via socket connection (works even without PID file)
		const { connect } = await import("node:net");
		return new Promise((resolve) => {
			const client = connect(resolvedSocketPath);
			const timeout = setTimeout(() => {
				client.destroy();
				resolve(false);
			}, 2000);

			client.on("connect", () => {
				clearTimeout(timeout);
				client.destroy();
				resolve(true);
			});

			client.on("error", () => {
				clearTimeout(timeout);
				if (pid !== null) {
					cleanupStalePidFiles(pidPath, resolvedSocketPath);
				}
				resolve(false);
			});
		});
	}

	/**
	 * Build spawn configuration without actually spawning.
	 * Exposed as a static method so tests can verify the config shape.
	 * Delegates to daemon-spawn.ts.
	 */
	static buildSpawnConfig(options?: DaemonOptions): SpawnConfig {
		return buildSpawnConfigImpl(options);
	}

	/** Spawn a new daemon as a detached background process. Delegates to daemon-spawn.ts. */
	static async spawn(
		options?: DaemonOptions,
	): Promise<{ pid: number; port: number }> {
		return spawnDaemon(options, Daemon.isRunning);
	}

	// ─── Private: HTTP Server ───────────────────────────────────────────────

	private startHttpServer(): Promise<void> {
		return startHttpServerImpl(this.asLifecycleContext());
	}

	private startOnboardingServer(): Promise<void> {
		return startOnboardingServerImpl(this.asLifecycleContext(), {
			caRootPath: this.tlsCerts?.caRoot ?? null,
			caCertDer: this.tlsCerts?.caCertDer ?? null,
			staticDir: this.staticDir,
		});
	}

	private closeOnboarding(): Promise<void> {
		return closeOnboardingServerImpl(this.asLifecycleContext());
	}

	private closeHttp(): Promise<void> {
		return closeHttpServerImpl(this.asLifecycleContext());
	}

	// ─── Private: IPC Server ────────────────────────────────────────────────

	private startIPCServer(): Promise<void> {
		return startIPCServerImpl(
			this.asLifecycleContext(),
			{
				addProject: (dir) => this.addProject(dir),
				removeProject: (slug) => this.removeProject(slug),
				getProjects: () => this.getProjects(),
				setProjectTitle: (slug, title) => {
					this.registry.updateProject(slug, { title });
				},
				getPinHash: () => this.pinHash,
				setPinHash: (hash) => {
					this.pinHash = hash;
					this.auth.setPinHash(hash);
					this.persistConfig();
				},
				getKeepAwake: () => this.keepAwake,
				setKeepAwake: (enabled) => {
					this.keepAwake = enabled;
					this.keepAwakeManager?.setEnabled(enabled);
					this.persistConfig();
				},
				persistConfig: () => this.persistConfig(),
				scheduleShutdown: () => {
					setTimeout(() => this.stop(), DAEMON_SHUTDOWN_DELAY_MS);
				},
				getInstances: () => this.instanceManager.getInstances(),
				getInstance: (id) => this.instanceManager.getInstance(id),
				addInstance: (id, config) =>
					this.instanceManager.addInstance(id, config),
				removeInstance: (id) => this.instanceManager.removeInstance(id),
				startInstance: (id) => this.instanceManager.startInstance(id),
				stopInstance: (id) => this.instanceManager.stopInstance(id),
				updateInstance: (id, updates) =>
					this.instanceManager.updateInstance(id, updates),
			},
			() => this.getStatus(),
		);
	}

	private closeIPC(): Promise<void> {
		return closeIPCServerImpl(this.asLifecycleContext());
	}

	// ─── Crash counter (delegated to CrashCounter) ─────────────────────────

	/**
	 * Reset the crash counter (called after successful uptime).
	 * Exposed for testing.
	 */
	resetCrashCounter(): void {
		this.crashCounter.reset();
	}

	/**
	 * Get crash timestamps (for testing).
	 */
	getCrashTimestamps(): number[] {
		return this.crashCounter.getTimestamps();
	}
}

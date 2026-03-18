# Multi-Instance OpenCode Support — Design

## Problem

The relay currently connects to a single OpenCode server. Users who need separate auth contexts (e.g., personal and work Anthropic accounts routed through different CLIProxyAPI ports) must run entirely separate relay daemons with separate config directories. There's no way to manage multiple OpenCode instances from one relay.

## Solution

Introduce `OpenCodeInstance` as a first-class entity between the Daemon and per-project relays. Each instance represents a running `opencode serve` process. Projects are bound to instances. The relay spawns, monitors, and stops managed instances.

```
Daemon
 +-- InstanceManager
      +-- Instance "personal" (port 4096, managed, healthy)
      |    +-- Project "/src/myapp" -> ProjectRelay
      |    +-- Project "/src/lib"   -> ProjectRelay
      +-- Instance "work" (port 4097, managed, healthy)
           +-- Project "/src/company-api" -> ProjectRelay
```

## Data Model

### OpenCodeInstance

```ts
interface OpenCodeInstance {
  id: string;              // user-chosen, unique (e.g., "work", "personal")
  name: string;            // display name (e.g., "Work Projects")
  port: number;            // port for opencode serve (4096, 4097, etc.)
  managed: boolean;        // true = relay spawns/stops process; false = external
  status: "starting" | "healthy" | "unhealthy" | "stopped";
  pid?: number;            // PID of spawned process (if managed)
  env?: Record<string, string>; // per-instance env vars passed to opencode serve
  exitCode?: number;       // last exit code (undefined if running)
  lastHealthCheck?: number; // timestamp of last successful health check
  restartCount: number;    // restarts since last healthy period
  createdAt: number;
}
```

### Project Binding

Projects gain an `instanceId` field:

```ts
interface ProjectInfo {
  slug: string;
  directory: string;
  title: string;
  lastUsed?: number;
  instanceId: string;   // which opencode instance this project uses
}
```

### Persistence (daemon.json)

```json
{
  "pid": 12345,
  "port": 2633,
  "instances": [
    {
      "id": "personal",
      "name": "Personal",
      "port": 4096,
      "managed": true,
      "env": {
        "ANTHROPIC_API_KEY": "ccs-internal-managed",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317/api/provider/claude/v1"
      }
    },
    {
      "id": "work",
      "name": "Work",
      "port": 4097,
      "managed": true,
      "env": {
        "ANTHROPIC_API_KEY": "ccs-internal-managed",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318/api/provider/claude/v1"
      }
    }
  ],
  "projects": [
    {
      "path": "/Users/me/src/myapp",
      "slug": "myapp",
      "instanceId": "personal",
      "addedAt": 1709500000000
    }
  ]
}
```

File permissions: 0600 (owner-only read/write) since env vars may contain secrets.

### Port Allocation

For managed instances, auto-assign starting from 4096, skipping ports in use. For external instances, user specifies URL/port.

### Backward Compatibility

When no `instances` array exists in config (upgrade from old format):
1. If `OPENCODE_URL` env var is set: create a "default" external instance pointing to that URL
2. If `--oc-port` is provided: create a "default" managed instance on that port
3. Existing projects get `instanceId: "default"`
4. No user action required — everything works as before

## Process Management

### InstanceManager class (new: `instance-manager.ts`)

Owns the lifecycle of OpenCode instances within the Daemon.

**Key methods:**

```ts
class InstanceManager extends EventEmitter {
  addInstance(id: string, config: InstanceConfig): Promise<OpenCodeInstance>
  removeInstance(id: string): Promise<void>
  getInstances(): OpenCodeInstance[]
  getInstance(id: string): OpenCodeInstance | undefined
  getInstanceUrl(id: string): string
  startInstance(id: string): Promise<void>
  stopInstance(id: string): Promise<void>
  reclaimOrphans(saved: SavedInstanceConfig[]): Promise<void>
  stopAll(): Promise<void>
  // Events: "status_changed", "instance_added", "instance_removed"
}
```

**Spawn flow:**

```
addInstance("work", { managed: true, port: 4097, env: {...} })
  -> isPortAvailable(4097)
  -> spawn("opencode", ["serve", "--port", "4097"], { env })
  -> healthPoll every 5s (GET /path)
  -> status: "starting" -> "healthy"
```

**Crash recovery:**

- Non-zero exit code: attempt restart with exponential backoff
- Max 3 restarts in 60s window (matches existing daemon crash logic)
- After max retries: status "stopped", broadcast error to frontend
- Exit code 0: intentional stop, no restart
- User-initiated stop: set `userStopped` flag, no restart

**Orphan reclamation (daemon restart):**

On startup, check `daemon.json` for previously managed instances:
1. PID still alive? Health-check to verify it's opencode (not PID reuse)
2. Yes: reclaim (update status to "healthy", resume monitoring)
3. No: respawn if managed, or mark "stopped" if external

**Port conflict detection:**

Before spawning, check if port is occupied:
- Occupied + matching PID from config: reclaim
- Occupied + different PID: error "Port 4097 in use by PID 12345"

**Signal propagation (daemon shutdown):**

1. Stop all project relays (close SSE/WS connections)
2. SIGTERM each managed opencode process
3. 5s timeout per process
4. SIGKILL any remaining
5. Handle double-SIGTERM (force exit)

**Resource limit:** Default max 5 managed instances (configurable).

### Daemon Integration

```ts
// Before:
private readonly opencodeUrl: string | null;

// After:
private readonly instanceManager: InstanceManager;
```

`addProject(directory, slug, instanceId)` resolves the opencode URL from the instance manager.

## CLI Interface

### Instance subcommands

```
opencode-relay instance list
opencode-relay instance add <name> [--port N] [--managed] [--external URL]
                                   [--env KEY=VALUE ...]
opencode-relay instance remove <name>
opencode-relay instance start <name>
opencode-relay instance stop <name>
opencode-relay instance status <name>
```

### Backward compatibility

```
# Old: still works, creates a "default" instance
opencode-relay --oc-port 4096

# New: starts daemon with configured instances
opencode-relay
```

### IPC protocol extensions

```
instance_list    -> { instances: OpenCodeInstance[] }
instance_add     -> { id, name, port, managed, env? }
instance_remove  -> { id }
instance_start   -> { id }
instance_stop    -> { id }
instance_status  -> { id } -> { instance, projects }
```

## Web UI

### Header: Instance Indicator

Small indicator next to the status dot showing current project's instance name + health color. Clicking opens the Instance Selector dropdown.

### Instance Selector Dropdown

Shows all instances with health status dots. Selecting an instance switches the view to show only its projects (or navigates to the first project of that instance). "Manage Instances" link at the bottom.

### Settings Panel: Instance Management

Gear icon in header opens settings panel with "Instances" tab:

- List of all instances with status, port, project count
- Click to expand: edit name, port, managed/external toggle, env vars (key-value editor with password masking), assigned projects, start/stop/remove buttons
- "Add Instance" button with inline form:
  - Name (required)
  - Managed or External
  - Managed: port (auto-suggested), env vars. Note: for managed instances, consider using CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) with CCS (https://github.com/kaitranntt/ccs) for credential management across providers
  - External: full URL
  - Env vars (optional key-value pairs)

### ProjectSwitcher Updates

Projects grouped by instance in the dropdown:

```
personal
  * myapp
  o mylib
work
  o company-api
[+ Add project]
```

When adding a project, an instance selector dropdown chooses which instance it belongs to (defaults to first healthy instance).

### WebSocket Protocol Extensions

```ts
// Server -> Client
{ type: "instance_list", instances: OpenCodeInstance[] }
{ type: "instance_status", instanceId: string, status: InstanceStatus }

// Client -> Server
{ type: "instance_add", name: string, port?: number, managed: boolean, env?: Record<string, string> }
{ type: "instance_remove", instanceId: string }
{ type: "instance_start", instanceId: string }
{ type: "instance_stop", instanceId: string }
```

### New Store: `instance.svelte.ts`

Module-level `$state` object following existing store pattern. Registered in `ws.svelte.ts` message dispatcher.

## Error Handling

### Instance unavailable

ConnectOverlay augmented: "OpenCode instance 'work' is not responding. [Start Instance] [Switch Instance]"

### Instance removed with bound projects

Confirmation dialog. Projects get `instanceId: null`, shown as disconnected.

### All instances down

Dashboard banner: "No healthy OpenCode instances. [Manage Instances]"

### First run (no instances configured)

Interactive setup prompt: "No OpenCode instances configured. Add one now?"

## Module Changes

| File | Change |
|------|--------|
| **NEW: `instance-manager.ts`** | Core InstanceManager class |
| **NEW: `stores/instance.svelte.ts`** | Frontend instance store |
| **NEW: `InstanceSelector.svelte`** | Header instance picker dropdown |
| **NEW: `InstanceManager.svelte`** | Settings panel for instance CRUD |
| `daemon.ts` | Replace `opencodeUrl` with InstanceManager |
| `config-persistence.ts` | Add `instances` to DaemonConfig, 0600 perms |
| `daemon-ipc.ts` | Add instance IPC handlers |
| `daemon-spawn.ts` | Pass instance env vars during spawn |
| `cli-core.ts` | Add `instance` subcommand routing |
| `cli-commands.ts` | Instance management commands |
| `types.ts` | OpenCodeInstance, InstanceConfig types |
| `shared-types.ts` | Instance types shared with frontend |
| `Header.svelte` | Add instance indicator |
| `ProjectSwitcher.svelte` | Group projects by instance |
| `ws.svelte.ts` | Handle instance message types |
| `relay-stack.ts` | Resolve opencodeUrl from instance |

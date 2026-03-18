# Instance Auto-Discovery & Provider Isolation UX Design

## Problem

The relay UI has a smart instance creation form with presets (Anthropic/CCS/Custom), structured fields, and proxy detection. But users still need to know *why* they'd create multiple instances and *how* to configure providers. The form duplicates configuration better handled by terminal tools (opencode config, CCS dashboard). Phone/tablet use is post-setup only.

## Decision

Replace the smart instance form with:
1. Auto-discovery of running OpenCode servers via port scanning
2. Scenario-based guided setup paths shown when no instances are found
3. Project-to-instance allocation via dropdown in the web UI
4. Instance renaming from both web UI and TUI

The web UI becomes a monitor/controller. Instance configuration happens on the machine via terminal.

## Architecture

### Auto-Discovery (Port Scanner)

A background service in the daemon that periodically probes a port range for running OpenCode servers on localhost.

**Scanner behavior:**
- Configurable port range (default: 4096-4110, 15 ports)
- Scan interval: every 10 seconds (configurable)
- HTTP GET to `http://127.0.0.1:{port}` with a 2-second timeout per probe
- A port is "discovered" if it returns a valid OpenCode response
- Discovered instances are registered as **unmanaged** instances

**Instance lifecycle:**
- **Discovery:** Scanner finds a new OpenCode server -> creates an unmanaged instance entry -> pushes `instance_list` update to all WS clients
- **Disappearance:** 3 consecutive failed probes before removing (handles transient blips)
- **Managed instances:** Instances started by the relay remain managed and are not subject to scanner removal. Scanner skips ports occupied by managed instances.
- **Manual scan:** A "Scan Now" button in the UI triggers an immediate scan cycle

**Config:**
```yaml
discovery:
  enabled: true
  portRange: [4096, 4110]
  intervalMs: 10000
  probeTimeoutMs: 2000
  removalThreshold: 3
```

### Web UI: Instance List

When instances ARE found, each instance shows:
- Name (auto-generated from port if discovered, e.g., "OpenCode :4098"; user-customizable)
- Status indicator (green/yellow/red dot)
- Port number
- Type badge: "managed" or "discovered"
- Actions: Start/Stop (managed only), project allocation
- "Scan Now" button at the top of the instance list

### Web UI: Getting Started (No Instances)

When no instances are found, a Getting Started panel shows three scenario-based guided paths with copyable terminal commands:

**Path 1: "Quick Start -- Direct API Key"**
```
1. Start an OpenCode server:
   $ opencode serve --port 4098

2. Configure your provider:
   $ opencode config set provider anthropic
   $ opencode config set anthropic.apiKey sk-ant-...

3. It will appear here automatically!
```

**Path 2: "Multi-Provider -- Via CCS"**
```
CCS manages OAuth tokens and API keys for 20+ providers.
One CCS proxy per OpenCode instance for full isolation.

1. Install CCS:
   $ npm install -g @kaitranntt/ccs

2. Authenticate your provider:
   $ ccs claude --auth

3. Start the CCS proxy:
   $ ccs cliproxy start

4. Start OpenCode pointing to CCS:
   $ ANTHROPIC_API_KEY="ccs-internal-managed" \
     ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \
     opencode serve --port 4098

--- For a second isolated instance (e.g., work account): ---

5. Create a separate CCS config:
   $ CCS_DIR=~/.ccs-work ccs claude --auth
   $ CCS_DIR=~/.ccs-work ccs cliproxy start

6. Start another OpenCode:
   $ ANTHROPIC_API_KEY="ccs-internal-managed" \
     ANTHROPIC_BASE_URL="http://127.0.0.1:8318/api/provider/claude/v1" \
     opencode serve --port 4099

Both instances appear here automatically!
```

**Path 3: "Custom Setup"**
```
Configure OpenCode with environment variables:
   $ ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098
   $ OPENAI_API_KEY=sk-... opencode serve --port 4099
```

Each path is a collapsible card. Terminal commands have a copy button. The "Scan Now" button appears below: "Already started an instance? -> Scan Now"

### Project Allocation

Each project (directory) can be assigned to a specific OpenCode instance:
- In the chat/project view header: a dropdown shows the current instance name
- Dropdown lists all instances with status indicators
- Selecting a different instance switches the project's connection
- Default: new projects auto-assign to the first healthy instance
- Assignments stored in daemon config as `projectAssignments: Record<string, string>` (directory path -> instance ID)

### Instance Naming

Users can rename instances from both web UI and TUI:
- **Web UI:** Click/edit icon on instance name in list -> sends `instance_rename` WS message
- **TUI:** `opencode-relay rename <instance-id> "work"` command
- Auto-discovered instances get default names from port: "OpenCode :4098"
- Custom names persist across scanner re-discovery (matched by port)
- Names must be unique

## CCS Integration Details (Verified)

From source code analysis of CCS v7.x (`kaitranntt/ccs`):

| Detail | Value |
|---|---|
| Auth env var | `ANTHROPIC_API_KEY` (what OpenCode reads) |
| Default auth token | `ccs-internal-managed` (constant: `CCS_INTERNAL_API_KEY`) |
| Provider-specific URL | `http://127.0.0.1:{port}/api/provider/{provider}/v1` |
| Model-based routing URL | `http://127.0.0.1:{port}/v1` (root, CCS routes by model name) |
| Default port | `8317` |
| Multi-instance isolation | `CCS_DIR=~/.ccs-{name}` for separate config dirs |

**Provider routing:** CCS CLIProxy serves all providers on one port via path-based routing. Each provider gets `/api/provider/{provider}/v1`. The `extractProviderFromPathname()` function parses the provider from the URL. Setting `ANTHROPIC_BASE_URL` to `/api/provider/claude/v1` gives access to only Claude. Other providers need their own path.

**One OpenCode instance = one CCS provider.** For multiple providers, use multiple CCS instances with `CCS_DIR` isolation, each on a different port.

## What This Replaces

The entire smart instance creation form from the `feat/smart-instance-form` branch:
- Preset bar (Anthropic/CCS/Custom) -> replaced by guided paths
- Structured provider fields (API key, base URL) -> removed from UI; done via terminal
- Feature flag checkboxes -> removed; configured via opencode config
- Proxy detection (`proxy_detect` WS message) -> removed; CCS detection moved to guided path status indicator
- `instance_add` WS message -> no longer sent from UI; instances are auto-discovered
- `instance_update` WS message -> replaced by `instance_rename` for name changes only
- Edit form -> removed entirely
- `instance-env.ts` utilities -> no longer needed in frontend

## What Stays

- Instance list with status indicators
- Start/Stop buttons for managed instances
- Remove button for managed instances
- Project allocation (new: directory -> instance dropdown)
- Instance naming (new: inline rename + TUI command)
- Auto-start OpenCode (from `f117256` commit)

## Scope

This design is for a **new branch** (not `feat/smart-instance-form`). The current branch ships as-is with the smart form. The new branch implements this design on top of main (after smart-form merges or independently).

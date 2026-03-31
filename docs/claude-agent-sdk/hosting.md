# Hosting the Agent SDK

> Source: https://platform.claude.com/docs/en/agent-sdk/hosting
> Extracted: 2026-03-31

Deploy and host Claude Agent SDK in production environments

---

The Claude Agent SDK differs from traditional stateless LLM APIs in that it maintains conversational state and executes commands in a persistent environment.

## Hosting Requirements

### Container-Based Sandboxing

For security and isolation, the SDK should run inside a sandboxed container environment providing process isolation, resource limits, network control, and ephemeral filesystems.

### System Requirements

Each SDK instance requires:

- **Runtime dependencies**
  - Python 3.10+ (for Python SDK) or Node.js 18+ (for TypeScript SDK)
  - Node.js (required by Claude Code CLI)
  - Claude Code CLI: `npm install -g @anthropic-ai/claude-code`

- **Resource allocation**
  - Recommended: 1GiB RAM, 5GiB of disk, and 1 CPU

- **Network access**
  - Outbound HTTPS to `api.anthropic.com`
  - Optional: Access to MCP servers or external tools

## Understanding the SDK Architecture

The Claude Agent SDK operates as a **long-running process** that:
- **Executes commands** in a persistent shell environment
- **Manages file operations** within a working directory
- **Handles tool execution** with context from previous interactions

## Sandbox Provider Options

- **[Modal Sandbox](https://modal.com/docs/guide/sandbox)**
- **[Cloudflare Sandboxes](https://github.com/cloudflare/sandbox-sdk)**
- **[Daytona](https://www.daytona.io/)**
- **[E2B](https://e2b.dev/)**
- **[Fly Machines](https://fly.io/docs/machines/)**
- **[Vercel Sandbox](https://vercel.com/docs/functions/sandbox)**

## Production Deployment Patterns

### Pattern 1: Ephemeral Sessions

Create a new container for each user task, then destroy it when complete. Best for one-off tasks.

**Examples:** Bug Investigation & Fix, Invoice Processing, Translation Tasks, Image/Video Processing

### Pattern 2: Long-Running Sessions

Maintain persistent container instances for long running tasks, often running multiple Claude Agent processes inside.

**Examples:** Email Agent, Site Builder, High-Frequency Chat Bots

### Pattern 3: Hybrid Sessions

Ephemeral containers hydrated with history and state, possibly from a database or from the SDK's session resumption features.

**Examples:** Personal Project Manager, Deep Research, Customer Support Agent

### Pattern 4: Single Containers

Run multiple Claude Agent SDK processes in one global container. Best for agents that must collaborate closely together.

**Examples:** Simulations (agents interacting in video games)

## FAQ

### How do I communicate with my sandboxes?
Expose ports to communicate with your SDK instances. Your application can expose HTTP/WebSocket endpoints for external clients.

### What is the cost of hosting a container?
The dominant cost is tokens; containers vary by provisioning, but minimum cost is roughly 5 cents per hour running.

### When should I shut down idle containers vs. keeping them warm?
Provider dependent. Tune timeout based on expected user response frequency.

### How often should I update the Claude Code CLI?
The CLI is versioned with semver, so any breaking changes will be versioned.

### How long can an agent session run before timing out?
Sessions will not timeout, but consider setting `maxTurns` to prevent loops.

## Next Steps

- [Secure Deployment](./secure-deployment.md)
- [Permissions](./permissions.md)
- [Cost Tracking](./cost-tracking.md)
- [MCP Integration](./mcp.md)

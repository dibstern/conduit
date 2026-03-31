# Securely deploying AI agents

> Source: https://platform.claude.com/docs/en/agent-sdk/secure-deployment
> Extracted: 2026-03-31

A guide to securing Claude Code and Agent SDK deployments with isolation, credential management, and network controls

---

Claude Code and the Agent SDK can execute code, access files, and interact with external services. This guide covers practical ways to maintain appropriate controls while getting the benefits of these tools.

## Threat model

Agents can take unintended actions due to prompt injection (instructions embedded in content they process) or model error. Defense in depth is good practice. For example, if an agent processes a malicious file, network controls can block unauthorized requests.

## Built-in security features

- **Permissions system**: Every tool and bash command can be configured to allow, block, or prompt
- **Static analysis**: Commands are analyzed for risky operations before execution
- **Web search summarization**: Search results are summarized to reduce prompt injection risk
- **Sandbox mode**: Bash commands can run in a sandboxed environment

## Security principles

### Security boundaries

Place sensitive resources (like credentials) outside the agent's boundary. Use proxies that inject credentials rather than exposing them directly.

### Least privilege

| Resource | Restriction options |
|----------|---------------------|
| Filesystem | Mount only needed directories, prefer read-only |
| Network | Restrict to specific endpoints via proxy |
| Credentials | Inject via proxy rather than exposing directly |
| System capabilities | Drop Linux capabilities in containers |

### Defense in depth

Layer multiple controls: container isolation, network restrictions, filesystem controls, request validation at a proxy.

## Isolation technologies

| Technology | Isolation strength | Performance overhead | Complexity |
|------------|-------------------|---------------------|------------|
| Sandbox runtime | Good (secure defaults) | Very low | Low |
| Containers (Docker) | Setup dependent | Low | Medium |
| gVisor | Excellent (with correct setup) | Medium/High | Medium |
| VMs (Firecracker, QEMU) | Excellent (with correct setup) | High | Medium/High |

### Sandbox runtime

[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) enforces filesystem and network restrictions at the OS level. No Docker configuration needed.

### Containers

Security-hardened Docker configuration:
```bash
docker run \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --network none \
  --memory 2g \
  --cpus 2 \
  --pids-limit 100 \
  --user 1000:1000 \
  -v /path/to/code:/workspace:ro \
  agent-image
```

With `--network none`, the container communicates only through mounted Unix sockets to a host proxy that enforces domain allowlists.

### gVisor

Intercepts system calls in userspace before they reach the host kernel. Use with `docker run --runtime=runsc`.

### Virtual machines

VMs provide hardware-level isolation through CPU virtualization extensions. Firecracker boots microVMs in <125ms with <5 MiB memory overhead.

## Credential management

### The proxy pattern

Run a proxy outside the agent's boundary that injects credentials into outgoing requests. The agent never sees actual credentials.

### Configuring Claude Code to use a proxy

- **`ANTHROPIC_BASE_URL`**: Route sampling requests to your proxy
- **`HTTP_PROXY` / `HTTPS_PROXY`**: Route all HTTP traffic through proxy

### Credentials for other services

- **Custom tools**: Route through MCP server to an external service
- **Traffic forwarding**: TLS-terminating proxy for arbitrary HTTPS services

## Filesystem configuration

### Read-only code mounting

```bash
docker run -v /path/to/code:/workspace:ro agent-image
```

> Exclude sensitive files: `.env`, `~/.git-credentials`, `~/.aws/credentials`, `*.pem`, `*.key`

### Writable locations

Use `tmpfs` mounts for ephemeral workspaces; overlay filesystems for reviewable changes.

## Further reading

- [Hosting the Agent SDK](./hosting.md)
- [Handling permissions](./permissions.md)
- [Sandbox runtime](https://github.com/anthropic-experimental/sandbox-runtime)

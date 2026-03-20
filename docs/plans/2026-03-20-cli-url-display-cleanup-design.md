# CLI URL Display Cleanup

## Problem

The CLI startup banner shows up to 3 URLs after the QR code, which is cluttered:

```
  [QR code → http://100.80.98.50:2634/setup]

  https://100.80.98.50:2633            ← primary (bold, Tailscale)
    https://192.168.1.164:2633         ← secondary (dim, LAN)
    Setup: http://100.80.98.50:2634/setup  ← setup (dim)
```

Issues:
1. Three URLs is too many — cluttered and confusing.
2. The QR code URL doesn't visually match any prominent link.
3. The setup URL uses the Tailscale IP redundantly with the primary.
4. No labels distinguish Tailscale from LAN.

## Design

### Core changes

1. **Setup URL becomes a QR caption** — shown as `Scan or visit: <url>` directly under the QR code, only when TLS is active (because the QR URL differs from the primary URL in that case).
2. **Max 2 URLs in the URL block** — primary (bold) + optional `Local: ...` (dim) when both Tailscale and LAN exist.
3. **QR always matches** either the caption (TLS) or the primary URL (no TLS).
4. **Tailscale stays primary**, LAN gets `Local:` label when both are present.

### Layout by scenario

**TLS + Tailscale + LAN:**
```
    [QR code]
  Scan or visit: http://100.80.98.50:2634/setup

  https://100.80.98.50:2633
    Local: https://192.168.1.164:2633

  14 projects · 0 sessions
```

**TLS + LAN only:**
```
    [QR code]
  Scan or visit: http://192.168.1.164:2634/setup

  https://192.168.1.164:2633

  14 projects · 0 sessions
```

**TLS + Tailscale only:**
```
    [QR code]
  Scan or visit: http://100.80.98.50:2634/setup

  https://100.80.98.50:2633

  14 projects · 0 sessions
```

**No TLS + network IP:**
```
    [QR code]

  http://192.168.1.164:2633

  14 projects · 0 sessions
```
No caption — QR encodes the primary URL, which is already visible below.

**Localhost only:**
```
  http://localhost:2633

  3 projects · 0 sessions
```
No QR, no setup.

## Implementation scope

### Data model change

Replace `setupUrl?: string` on `DaemonInfo` with `qrCaption?: string`.

### Files to change

1. **`src/lib/cli/cli-menu.ts`** — Update `DaemonInfo` interface: replace `setupUrl` with `qrCaption`. Update `renderStatus()`: render caption directly after QR lines (dim), add `Local:` label for `networkUrls`.
2. **`src/bin/cli-commands.ts`** — Update `buildDaemonInfo()`: compute `qrCaption` instead of `setupUrl`. Caption = `Scan or visit: http://<ip>:<port+1>/setup` when TLS is active.
3. **`src/bin/cli-core.ts`** — Update legacy non-interactive URL display with same logic.

### Non-interactive path

The non-interactive path in `cli-core.ts` (lines 652-681) should follow the same rules: caption under QR when TLS, max 2 URLs, `Local:` label.

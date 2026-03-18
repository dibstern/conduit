# Integration Plan: DiffView, PastePreview, ProjectSwitcher

Three Svelte components are fully implemented but not yet wired into the application. This plan details the exact changes needed to integrate each one.

---

## 1. DiffView — Wire into ToolItem for Edit/Write tool diffs

### Problem
`DiffView.svelte` exists with full unified/split diff rendering, but `ToolItem.svelte` currently renders all tool results as plain text. Edit/Write tool results should show rich file diffs.

### Data Flow
```
Server (event-translator.ts):
  tool_executing → { type: "tool_executing", id, name, input: { file_path, old_string, new_string } }

Frontend:
  ws.svelte.ts → handleToolExecuting(msg) → updates ToolMessage in chatState.messages
  ToolItem.svelte → detects Edit tool with input → renders <DiffView>
```

### Changes Required

#### 1a. Add `input` field to `ToolMessage` type (`types.ts`)

```ts
// types.ts — ToolMessage interface
export interface ToolMessage {
    type: "tool";
    uuid: string;
    id: string;
    name: string;
    status: "pending" | "running" | "completed" | "error";
    result?: string;
    isError?: boolean;
    input?: Record<string, unknown>;  // ← ADD THIS
}
```

#### 1b. Capture `input` in `handleToolExecuting` (`stores/chat.svelte.ts`)

Currently:
```ts
export function handleToolExecuting(msg: WsMessage): void {
    const id = msg.id as string;
    const uuid = toolUuidMap.get(id);
    if (!uuid) return;

    const messages = [...chatState.messages];
    const idx = messages.findIndex((m) => m.type === "tool" && m.uuid === uuid);
    if (idx >= 0) {
        messages[idx] = { ...(messages[idx] as ToolMessage), status: "running" };
        chatState.messages = messages;
    }
}
```

Change to:
```ts
export function handleToolExecuting(msg: WsMessage): void {
    const id = msg.id as string;
    const uuid = toolUuidMap.get(id);
    if (!uuid) return;

    const messages = [...chatState.messages];
    const idx = messages.findIndex((m) => m.type === "tool" && m.uuid === uuid);
    if (idx >= 0) {
        const input = msg.input as Record<string, unknown> | undefined;
        messages[idx] = {
            ...(messages[idx] as ToolMessage),
            status: "running",
            ...(input ? { input } : {}),
        };
        chatState.messages = messages;
    }
}
```

#### 1c. Render `DiffView` in `ToolItem.svelte` for Edit tools

Add import and conditional rendering:
```svelte
<script lang="ts">
    import DiffView from "../features/DiffView.svelte";
    // ... existing imports

    // Detect if this is an Edit tool with diff data
    const hasEditDiff = $derived(
        message.name === "Edit" &&
        message.input?.old_string != null &&
        message.input?.new_string != null
    );

    const editFilename = $derived(
        hasEditDiff ? (message.input?.file_path as string)?.split("/").pop() : undefined
    );

    // Auto-expand Edit tools with diffs
    let expanded = $state(false);

    $effect(() => {
        // Auto-expand when Edit tool completes with diff data
        if (hasEditDiff && message.status === "completed" && !expanded) {
            expanded = true;
        }
    });
</script>

<!-- In the template, replace the plain-text result block: -->
{#if expanded && hasEditDiff}
    <div class="my-0.5 ml-[18px]">
        <DiffView
            oldText={message.input?.old_string as string}
            newText={message.input?.new_string as string}
            filename={editFilename}
        />
    </div>
{:else if expanded && message.result}
    <div class="tool-result font-mono text-xs whitespace-pre-wrap ...">
        {message.result}
    </div>
{/if}
```

### Test Plan
- [ ] Verify Edit tool messages from the relay include `input` data
- [ ] Verify DiffView renders correctly with unified/split toggle
- [ ] Verify non-Edit tools still show plain text results
- [ ] Verify auto-expand works for Edit tools
- [ ] pnpm check passes
- [ ] pnpm test passes

---

## 2. PastePreview — Wire into InputArea for paste handling

### Problem
`PastePreview.svelte` renders image thumbnails but is not mounted anywhere. `InputArea.svelte` has no paste event handling, no image/paste state management, and the file attach buttons don't complete their file read operations.

### Data Flow
```
User pastes content → InputArea paste handler:
  Image?  → Convert to base64 → Add to pendingImages[] → PastePreview renders thumbnail
  Long text (≥500 chars)? → Store in pendingPastes[] → PastePreview renders "PASTED" chip
  Short text? → Insert into textarea normally

User sends message:
  wsSend({ type: "message", text, images?, pastes? })

Server (relay-stack or ws-router):
  Concatenates pastes[] with text before sending to OpenCode
```

### Changes Required

#### 2a. Extend `PastePreview.svelte` to support text paste chips

Add a `pastes` prop alongside `images`:
```svelte
<script lang="ts">
    import type { PendingImage, PendingPaste } from "../../types.js";

    let {
        images,
        pastes,
        onRemoveImage,
        onRemovePaste,
    }: {
        images: PendingImage[];
        pastes: PendingPaste[];
        onRemoveImage: (id: string) => void;
        onRemovePaste: (id: string) => void;
    } = $props();
</script>

<!-- Render paste chips alongside image thumbnails -->
{#each pastes as paste (paste.id)}
    <div class="paste-chip group relative shrink-0 flex items-center gap-1.5 bg-bg-alt border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-secondary max-w-[180px]">
        <span class="truncate">{paste.preview}</span>
        <span class="text-[10px] text-accent font-medium uppercase shrink-0">Pasted</span>
        <button
            class="paste-remove-btn ..."
            onclick={() => onRemovePaste(paste.id)}
        >&#x2715;</button>
    </div>
{/each}
```

#### 2b. Add `PendingPaste` type to `types.ts`

```ts
export interface PendingPaste {
    id: string;
    text: string;
    preview: string; // first 50 chars
}
```

#### 2c. Add paste handling to `InputArea.svelte`

Major additions:
1. Import PastePreview component
2. Add state for pending images and pastes
3. Add paste event handler
4. Wire file attach buttons to read files
5. Include images/pastes in sendMessage payload

```svelte
<script lang="ts">
    import PastePreview from "../features/PastePreview.svelte";
    import { generateUuid } from "../../utils/format.js";
    import type { PendingImage, PendingPaste } from "../../types.js";

    const PASTE_THRESHOLD = 500;

    // ─── Paste/Image state ─────────────────────────────────────────────
    let pendingImages = $state<PendingImage[]>([]);
    let pendingPastes = $state<PendingPaste[]>([]);

    const hasAttachments = $derived(pendingImages.length > 0 || pendingPastes.length > 0);

    // ─── Paste handler ─────────────────────────────────────────────────
    function handlePaste(e: ClipboardEvent) {
        const clip = e.clipboardData;
        if (!clip) return;

        // Check for images
        for (const item of clip.items) {
            if (item.type.startsWith("image/")) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) addImageFile(file);
                return;
            }
        }

        // Check for long text
        const text = clip.getData("text/plain");
        if (text && text.length >= PASTE_THRESHOLD) {
            e.preventDefault();
            const id = generateUuid();
            const preview = text.slice(0, 50).replace(/\n/g, " ");
            pendingPastes = [...pendingPastes, { id, text, preview }];
        }
        // Short text: let browser handle normally
    }

    function addImageFile(file: File) {
        const reader = new FileReader();
        reader.onload = () => {
            const id = generateUuid();
            pendingImages = [...pendingImages, {
                id,
                dataUrl: reader.result as string,
                name: file.name,
                size: file.size,
            }];
        };
        reader.readAsDataURL(file);
    }

    function removeImage(id: string) {
        pendingImages = pendingImages.filter(i => i.id !== id);
    }

    function removePaste(id: string) {
        pendingPastes = pendingPastes.filter(p => p.id !== id);
    }

    // ─── Updated sendMessage ───────────────────────────────────────────
    function sendMessage() {
        const text = inputText.trim();
        if ((!text && !hasAttachments) || isProcessing) return;

        addUserMessage(text);

        const payload: Record<string, unknown> = { type: "message", text };
        if (pendingImages.length > 0) {
            payload.images = pendingImages.map(i => i.dataUrl);
        }
        if (pendingPastes.length > 0) {
            payload.pastes = pendingPastes.map(p => p.text);
        }
        wsSend(payload);

        inputText = "";
        pendingImages = [];
        pendingPastes = [];
        if (textareaEl) textareaEl.style.height = "auto";
    }

    // ─── Updated file attach handlers ──────────────────────────────────
    function handleAttachCamera() {
        attachMenuOpen = false;
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.capture = "environment";
        fileInput.onchange = () => {
            if (fileInput.files?.[0]) addImageFile(fileInput.files[0]);
        };
        fileInput.click();
    }

    function handleAttachPhotos() {
        attachMenuOpen = false;
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.onchange = () => {
            if (fileInput.files) {
                for (const file of fileInput.files) addImageFile(file);
            }
        };
        fileInput.click();
    }
</script>

<!-- In the template, before the textarea: -->
{#if hasAttachments}
    <PastePreview
        images={pendingImages}
        pastes={pendingPastes}
        onRemoveImage={removeImage}
        onRemovePaste={removePaste}
    />
{/if}

<!-- Add onpaste to the textarea: -->
<textarea
    ...
    onpaste={handlePaste}
></textarea>
```

#### 2d. Server-side paste concatenation

In the relay's WS message handler (wherever `type: "message"` is processed), concatenate paste text:
```ts
// When sending to OpenCode
let fullText = msg.text || "";
if (Array.isArray(msg.pastes)) {
    for (const pasteText of msg.pastes) {
        if (fullText) fullText += "\n\n";
        fullText += pasteText;
    }
}
```

**Note:** This requires checking the existing relay-stack code. The server-side change may already handle images (check how `msg.images` is processed) but paste concatenation is likely missing.

### Test Plan
- [ ] Paste image → thumbnail appears in preview bar
- [ ] Paste long text (≥500 chars) → "PASTED" chip appears, text NOT inserted in textarea
- [ ] Paste short text → inserted normally in textarea
- [ ] Remove image/paste chip → removed from preview
- [ ] Send message with images → images included in WS payload
- [ ] Send message with pastes → pastes included in WS payload
- [ ] Camera/photos buttons read files and add to preview
- [ ] Server concatenates paste text with main message
- [ ] pnpm check passes
- [ ] pnpm test passes

---

## 3. ProjectSwitcher — Wire into Header

### Problem
`ProjectSwitcher.svelte` is fully built with dropdown UI and navigation, but `Header.svelte` renders the project name as plain text and doesn't import ProjectSwitcher.

### Data Flow
```
ChatLayout → onConnect → wsSend({ type: "get_sessions" })
                         wsSend({ type: "switch_project", slug })

Server → { type: "project_list", projects: [...], current: "slug" }
    (sent in response to get_sessions or switch_project)

ws.svelte.ts → dispatches to _projectListeners
Header → onProject listener → updates local projectList state
Header → renders <ProjectSwitcher projects={projectList} currentSlug={slug} />
```

### Changes Required

#### 3a. Wire ProjectSwitcher into `Header.svelte`

```svelte
<script lang="ts">
    import ProjectSwitcher from "../features/ProjectSwitcher.svelte";
    import { onProject } from "../../stores/ws.svelte.js";
    import type { ProjectInfo, WsMessage } from "../../types.js";

    // ─── Project list state (populated by project_list WS messages) ──
    let projects = $state<ProjectInfo[]>([]);

    $effect(() => {
        const unsub = onProject((msg: WsMessage) => {
            if (msg.type === "project_list") {
                projects = (msg.projects as ProjectInfo[]) ?? [];
            }
        });
        return unsub;
    });
</script>

<!-- Replace the plain-text project name with: -->
<div id="header-left" class="flex items-center gap-2 min-w-0 shrink-0">
    <!-- sidebar expand/hamburger buttons unchanged -->
    <ProjectSwitcher {projects} currentSlug={getCurrentSlug()} />
</div>
```

#### 3b. Verify `project_list` message is sent by the server

The relay already has project list support:
- `ws.svelte.ts` routes `project_list` to `_projectListeners` (line 307)
- ChatLayout sends `switch_project` on connect (line 97)

**Check needed:** Does the relay server actually send `project_list` messages? Search for `project_list` in the server code. If not, this may need a server-side addition to:
1. On `switch_project`: respond with `{ type: "project_list", projects: [...] }`
2. Or on `get_sessions`: include project info in the response

#### 3c. Handle project navigation

ProjectSwitcher already calls `navigate()` from `router.svelte.ts`. When the route changes to a new `/p/{slug}/`, ChatLayout's `$effect` should:
1. Detect the slug change
2. Re-establish the WebSocket connection (or send `switch_project`)
3. Clear current messages

**Check needed:** Verify that navigating to a new slug triggers the ChatLayout's onConnect effect to re-send `switch_project` with the new slug. If ChatLayout doesn't re-mount on slug change, the `$effect` with `connect()` won't re-run. Solution: make the slug a dependency of the connection effect.

### Test Plan
- [ ] Single project: ProjectSwitcher renders as static text in header
- [ ] Multiple projects: dropdown shows all projects with status
- [ ] Clicking a different project navigates to its slug
- [ ] After navigation, new project's session loads
- [ ] Client count badges show per-project
- [ ] pnpm check passes
- [ ] pnpm test passes

---

## Implementation Order

**Recommended sequence:**

1. **ProjectSwitcher** (smallest change, self-contained)
   - Edit Header.svelte to import + render ProjectSwitcher
   - Add onProject listener subscription
   - Test with single-project setup (static display)

2. **DiffView** (medium change, touches types + store + component)
   - Add `input` field to ToolMessage type
   - Update handleToolExecuting in chat store
   - Update ToolItem.svelte to conditionally render DiffView
   - Test with Edit tool invocations

3. **PastePreview** (largest change, new behavior + server side)
   - Extend PastePreview to support text chips
   - Add paste handling to InputArea
   - Wire file attach buttons
   - Add server-side paste concatenation
   - Test paste workflows end-to-end

### Estimated Effort
| Feature | Frontend | Server | Total |
|---------|----------|--------|-------|
| ProjectSwitcher | ~30 min | 0 (verify only) | ~30 min |
| DiffView | ~1 hour | 0 (data already sent) | ~1 hour |
| PastePreview | ~2 hours | ~30 min | ~2.5 hours |
| **Total** | | | **~4 hours** |

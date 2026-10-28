# Photo attachment

A user attaches photos from **Attach → Add Photos** (or **Take Photo** on a phone). Each photo shows as a thumbnail chip above the input with a remove button. On send, the image is stored once by content hash, shown under the user message, and passed to the provider with the text. Pasting an image into the composer does nothing.

## Sub-features

- `photo-menu` opens **Attach** (`[aria-label=Attach]`) with `#attach-camera` (Take Photo), `#attach-photos` (Add Photos), `#attach-files` (Add Files) and `attach-set-goal`.
- `photo-chip` shows `[data-testid=draft-attachment]` with `data-status="saved"` and an `<img>` in `#image-preview .paste-thumb`.
- `photo-remove` removes a chip with its `Remove image` button.
- `photo-sent` shows the image under the user message (`user-message-attachments`).
- `photo-provider` passes the image to the provider. Proven for Codex only, see Gotchas.
- `photo-queued` shows `1 image` on a queued row (see [queued-messages.md](./queued-messages.md)).
- `photo-paste` is not supported.

## How to get to it (user POV)

- Click **+** (Attach), then **Add Photos**, and pick an image file. Claude, Codex and Cursor showed all four items; on Cursor the goal item is disabled.
- Remove a chip with the **x** on its thumbnail. Type a message and send.

## Driving it with playwright-cli

Any small image works. These runs used an 8x8 red PNG, 75 bytes, `red8.png`.

```bash
D="test-results/verify-conduit/$RUN_ID/photo-attachment"
mkdir -p "$D"
$V up
$V new-session
$V pick-model --harness codex --model gpt-6.1-sol --provider codex
$V click '[aria-label=Attach]'
$V upload-image red8.png
$V screenshot --file "$D/01-chip.png"
$V send 'Say hello'
cp "$RUN_DIR/codex-wire.jsonl" "$D/02-codex-wire.jsonl"
$V store sql "select hash, mime, size from attachment_blobs" > "$D/03-blobs.json"
$V store sql "select type, metadata from message_parts where type='file'" > "$D/03-parts.json"
$V screenshot --file "$D/04-sent.png"
```

`$RUN_DIR` is `test-results/verify-conduit/$RUN_ID`. Claude, Cursor and OpenCode use the same steps with their `pick-model` values from [chat.md](./chat.md). For Cursor, also copy `cursor-capture.jsonl`.

Check the provider request:

```bash
D="test-results/verify-conduit/$RUN_ID/photo-attachment"
mkdir -p "$D"
python3 -c 'import json,sys; [print([i["type"] for i in m["params"]["input"]]) for m in (json.loads(l).get("message",{}) for l in open(sys.argv[1])) if m.get("method")=="turn/start"]' "$D/02-codex-wire.jsonl"
```

Check these results:

- After the upload, one chip with `data-status="saved"` and one `#image-preview .paste-thumb`. Its `img` has `alt="red8.png"` and `src=/p/process-test/attachments/<hash>`.
- `attachment_blobs` has one row: `mime` `image/png`, `size` 75, bytes equal to the file. The hash is sha256 of the mime, a NUL byte and the bytes, so it differs from the file's plain sha256. Two uploads of the same file share one blob.
- `input.admitted` carries `request.images` `[{attachmentHash, mime:"image/png", name:"red8.png"}]` on every harness.
- Claude and Codex: the stored user message has a `text` part and a `file` part with `filename` `red8.png` and the same `attachmentHash`. The transcript shows a 96 px thumbnail under the text. Claude replies `pong`, Codex `Hello from the mock model.`.
- Codex: `turn/start` input is `[text, image]`, and the image's `url` is `data:image/png;name=red8.png;base64,<file bytes>`, an exact match.
- Paste probe: dispatching a `paste` event with an image file on `#input` leaves it not `defaultPrevented`, with zero chips.

Evidence from 2026-10-28: `test-results/verify-conduit/b-photo/evidence/` (Codex, Cursor, OpenCode, paste probe), `b-queue/evidence/20-*` to `25-*` (Claude, queued image).

## Gotchas

- `upload-image` opens Attach if needed, selects Add Photos through its filechooser and closes the menu. Do not click Add Photos separately before calling it.
- The menu items have ids, not test ids: `#attach-photos`, not `[data-testid=attach-photos]`.
- `codex-wire.jsonl` appends across Codex processes and transports. Later usage polls preserve the turn's wire rows. Concurrent captures can interleave.
- **Cursor drops the image.** The chip saves and `input.admitted` and `pending_inputs.images` carry it. But the stored user message has only a `text` part, no thumbnail shows, and `cursor-capture.jsonl`'s `send.options` has only `prompt: "Say hello"`. `src/lib/provider/cursor/cursor-runner-payload.ts:751` sends `input.prompt` alone. The UI gives no warning. Product bug, not fixed (`b-photo/evidence/06-*`, `07-*`, `08-*`).
- Claude's provider request can't be read under replay. The replay records only text blocks in `claude-options.jsonl` (`test/helpers/replay-claude-process-sdk.ts:86`), so the image block conduit builds is not visible. Claude is proven up to the stored request and message parts.
- OpenCode's provider request can't be read either. The mock keeps request bodies in memory only, and the stored user message is the recording's, so it has no `file` part. Proven up to `input.admitted`.
- **Pasting an image is not supported.** The composer has no paste handler for images. Only the terminal reads the clipboard.
- Take Photo (`#attach-camera`) uses a `capture="environment"` input. It was not driven, since `upload-image` targets the Add Photos input.
- Add Files (documents) is a separate path and is not covered here.

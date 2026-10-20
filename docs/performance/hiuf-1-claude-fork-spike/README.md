# Claude mid-turn fork spike

Run ac99107e-05c7-4767-99d6-0f87ec1aa053 at 2026-10-20T07:12:57.097Z. SDK 0.3.301, bundled CLI 2.1.301, Node v26.10.0, model sonnet.

Recommendation: **7A**. 7A mid-turn fork=true; 7C mid-turn fork=true. [C.json:24](./C.json#L24), [E.json:23](./E.json#L23).

Custom session id honoured: goal source=true; no-goal source=true. [B.json:23](./B.json#L23), [C.json:24](./C.json#L24).

7A is the better fit because the first query both forks at the cut and honours the caller's chosen id. The standalone 7C API also works, but returns its own new id and needs a separate operation before the resume query. Retry must switch to plain resume once the custom transcript exists; blindly repeating 7A collides.

Native /goal supported=true; active goal in source transcript=true. A model reply instead of the clear command's local record counts as unsupported, even if the model says it cleared the goal. Unsupported commands use the requested plain-instruction fallback; that cannot establish native goal clearing. The initial banana goal auto-completes at the first Stop, so setup aborts immediately after its model reply streams and before Stop evaluates it. This preserves a complete assistant message and the active goal sentinel for the subsequent slow-tool turn.

The clear is not silent. Its command_lifecycle records have state queued then started. There is one synthetic assistant record, model `<synthetic>`, with local_command_source and local_command_run={command:goal,args:clear}; isSynthetic is absent. The success result has local_command=goal, num_turns=0 and duration_api_ms=0. There is no model assistant reply. The transcript contains the command as type user, isSidechain=false, no isMeta flag, and its output as type system, subtype local_command, isSidechain=false, isMeta=false. A frontend must suppress this command and its synthetic output if the clear is to stay hidden. [B.json:24](./B.json#L24).

Hidden /goal clear recognised=true. Exact stream shapes: ["system/hook_started","system/hook_started","system/hook_response","command_lifecycle","command_lifecycle","system/init","assistant","result/success"]. Assistant text: "Goal cleared: reply with the word banana to every message". User/goal/record stream messages: [{"type":"assistant","message":{"diagnostics":null,"id":"5bf8cb92-d754-4dd0-ab96-b9fb18a66c59","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"end_turn","stop_sequence":null,"type":"message","usage":{"output_tokens_details":null,"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null,"fallback_credit":null},"content":[{"type":"text","text":"Goal cleared: reply with the word banana to every message"}],"context_management":null},"parent_tool_use_id":null,"local_command_source":"<local-command-stdout>Goal cleared: reply with the word banana to every message</local-command-stdout>","session_id":"04ba33b0-46ca-453b-8ace-6d6c1fa019cd","uuid":"c47f30f6-1b44-4218-9e91-d4a7e3e9faac","timestamp":"2026-10-20T07:13:16.606Z","local_command_run":{"command":"goal","args":"clear"}}]. [B.json:24](./B.json#L24).

Clear transcript entries, including original JSONL line numbers, types and flags:

```json
[
  {
    "line": 5,
    "raw": {
      "parentUuid": null,
      "isSidechain": false,
      "type": "attachment",
      "uuid": "66dc9957-2525-477e-8550-9013277c123b",
      "timestamp": "2026-10-20T07:12:59.883Z",
      "attachment": {
        "type": "goal_status",
        "met": false,
        "sentinel": true,
        "condition": "reply with the word banana to every message"
      },
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  },
  {
    "line": 14,
    "raw": {
      "parentUuid": "40954eaa-61c1-44d6-9a99-8a3bd2b75cb9",
      "isSidechain": false,
      "type": "attachment",
      "uuid": "81d2bfeb-96bb-4403-84ae-d9acac79eacb",
      "timestamp": "2026-10-20T07:13:16.606Z",
      "attachment": {
        "type": "goal_status",
        "met": true,
        "sentinel": true,
        "condition": "reply with the word banana to every message"
      },
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  },
  {
    "line": 16,
    "raw": {
      "parentUuid": "c32f83ed-1775-4218-89f4-24406590f591",
      "isSidechain": false,
      "promptId": "a463c5ab-5e88-431d-aa76-74eec4ff9605",
      "type": "user",
      "message": {
        "role": "user",
        "content": "<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>clear</command-args>"
      },
      "uuid": "f4bbde0c-1f71-43a7-9730-e37c237318ae",
      "timestamp": "2026-10-20T07:13:16.605Z",
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  },
  {
    "line": 17,
    "raw": {
      "parentUuid": "f4bbde0c-1f71-43a7-9730-e37c237318ae",
      "isSidechain": false,
      "type": "system",
      "subtype": "local_command",
      "content": "<local-command-stdout>Goal cleared: reply with the word banana to every message</local-command-stdout>",
      "level": "info",
      "timestamp": "2026-10-20T07:13:16.606Z",
      "uuid": "c47f30f6-1b44-4218-9e91-d4a7e3e9faac",
      "isMeta": false,
      "commandRun": {
        "command": "goal",
        "args": "clear"
      },
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  }
]
```

Goal metadata entries after clear:

```json
[
  {
    "line": 5,
    "raw": {
      "parentUuid": null,
      "isSidechain": false,
      "type": "attachment",
      "uuid": "66dc9957-2525-477e-8550-9013277c123b",
      "timestamp": "2026-10-20T07:12:59.883Z",
      "attachment": {
        "type": "goal_status",
        "met": false,
        "sentinel": true,
        "condition": "reply with the word banana to every message"
      },
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  },
  {
    "line": 14,
    "raw": {
      "parentUuid": "40954eaa-61c1-44d6-9a99-8a3bd2b75cb9",
      "isSidechain": false,
      "type": "attachment",
      "uuid": "81d2bfeb-96bb-4403-84ae-d9acac79eacb",
      "timestamp": "2026-10-20T07:13:16.606Z",
      "attachment": {
        "type": "goal_status",
        "met": true,
        "sentinel": true,
        "condition": "reply with the word banana to every message"
      },
      "userType": "external",
      "entrypoint": "sdk-ts",
      "cwd": "/private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053",
      "sessionId": "04ba33b0-46ca-453b-8ace-6d6c1fa019cd",
      "version": "2.1.301",
      "gitBranch": "HEAD"
    }
  }
]
```

Reply to 2+2 after clear: "**4**"; still follows banana=false. [B.json:25](./B.json#L25).

E compares standalone 7C against C's exact no-goal Source and cut UUID. Both are saved in E.json under details.standalone and in C.json under details.source. The 7C pre-resume transcript proves the cut content was copied with remapped UUIDs and the aborted slow-tool turn was excluded. [E.json:23](./E.json#L23).

Retry: {
  "customId": "2d67e8a4-9a23-4923-a0ca-58190286820f",
  "abortedAfterInit": true,
  "fileExistsAfterInit": true,
  "identical7AWorks": false,
  "identical7AError": "Error: Claude Code process exited with code 1. stderr: Error: Session ID 2d67e8a4-9a23-4923-a0ca-58190286820f is already in use.",
  "plainResumeWorks": true,
  "plainResumeId": "2d67e8a4-9a23-4923-a0ca-58190286820f",
  "collision": true,
  "filesCreatedByCrash": [
    "~/.ccs/instances/work2claude/projects/-private-tmp-hiuf-1-spike-cwd-ac99107e-05c7-4767-99d6-0f87ec1aa053/2d67e8a4-9a23-4923-a0ca-58190286820f.jsonl"
  ],
  "filesCreatedByRetry": [],
  "filesCreatedByResume": []
}. [D.json:23](./D.json#L23), [D.json:24](./D.json#L24).

Use 7A for the first launch, save the custom id before launching, then check whether its transcript exists after a crash before choosing plain resume or another fork attempt. The identical-options retry result above determines whether blindly repeating the fork is safe. Goal handling remains conditional on this CLI recognising /goal.

## Reproduce

```sh
node --import tsx scripts/spikes/hiuf-1-claude-fork-spike.ts
```

Scratch cwd: /private/tmp/hiuf-1-spike-cwd/ac99107e-05c7-4767-99d6-0f87ec1aa053. CLAUDE_CONFIG_DIR was inherited unchanged as ~/.ccs/instances/work2claude. Checked both the inherited config's project directories and ~/.claude/projects. No files there were edited by this script; only the SDK/CLI writes transcripts. Each launch saves the complete raw stream, stderr, input UUIDs, file lists and relevant transcript snapshots. Transcript snapshots also preserve metadata outside the visible parent chain; success requires a completed result and the cut copied without the aborted tool.

The SDK types consulted are sdk.d.ts:854, 859, 1740, 2117-2139 and the full resumeDropsTurn comment. This experiment intentionally uses the requested last finished assistant UUID, ordinary text turns, no resumeDropsTurn, and no end-turn tools. UUIDs are remapped by standalone forkSession, so 7C checks the cut message content before resume. Runtime local-command records have assistant type, model `<synthetic>`, local_command_source and local_command_run; they must not be mistaken for a model reply.

Official session semantics: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions). Observed behavior and the recommendation above come from the saved real-CLI evidence.

## Limitations

One run with this account, CLI and SDK version. An abort after system/init models process interruption through the SDK, not SIGKILL or power loss. The script waits 800 ms for transcript flush. Native goal results are valid only when the command emits a local record and the source transcript proves an active goal. No product code, tests, migrations or Beads state changed.


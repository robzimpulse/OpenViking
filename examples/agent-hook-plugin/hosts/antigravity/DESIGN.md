# Antigravity host contract

Established facts for the Google Antigravity host, per
`docs/en/agent-integrations/18-plugin-development.md` §2. This file records what the
`antigravity` adapter must honour; read it before changing that adapter.

**Verified against**: Antigravity App **2.28.2**, model `gemini-3.8-flash-medium`,
macOS 26.x / darwin 25.5.0, 2026-11-04. Antigravity CLI (`agy`) and IDE not exercised.

**Method**: a throwaway probe plugin (`~/.gemini/config/plugins/ov-probe`, removed afterwards)
registered a command handler on every documented event. Each handler appended its argv, cwd,
environment key names and raw stdin to a local JSONL log, returned a valid response, and on
`Stop` copied the transcript and spawned a detached worker that logged at 0/5/20/60 s. Two
conversations, 9 user turns, including tool loops (`run_command`, `read_file`), a retried
message, an app restart and a return to an earlier conversation.

Legend: **verified** = observed in a real session · *documented* = only in the host docs
(`antigravity.google/docs/hooks`, `/docs/build-plugins`, `/docs/plugins`) · **pending** = not
reproduced.

## 1. Versions and platforms

| Item | Value |
| --- | --- |
| Host | Antigravity App 2.28.2 (also loads plugins: CLI, IDE — *documented*) |
| Verified OS | macOS only; Linux and Windows untested |
| Node runtime | Not bundled. Hooks inherit the user's **login-shell PATH** (Homebrew, nvm, pyenv entries present), so bare `node` resolved (**verified**) |

## 2. Installation

| Form | Status |
| --- | --- |
| Plugin directory in `~/.gemini/config/plugins/<name>/` (global) | **verified** — loaded on next app start |
| `.agents/plugins/<name>/` (workspace) | *documented* |
| `agy plugin install <dir>` / GitHub URL / marketplace | *documented*; GitHub subdirectory support undocumented |
| Manifest | `plugin.json` at the root (or `.antigravity-plugin/plugin.json`); `additionalProperties: false`, `name` kebab-case (*documented*) |
| Hooks file | `hooks.json` at the plugin root (**verified**) |
| MCP file | `mcp_config.json` at the root, `mcpServers` map; tools namespaced `<plugin>_<server>` (*documented*, **pending**) |

- Hook commands run with **cwd = plugin root** (**verified**), so commands use relative paths
  (`node ./scripts/hook.mjs …`). Absolute paths are unnecessary and unportable.
- `PLUGIN_ROOT` / `PLUGIN_DATA` are **not** exported to hook processes (**verified**: no
  `PLUGIN_*` keys in the hook environment). They are *documented* for MCP `args`/`cwd`/`env`.
- The plugin root is read-only and replaced on update (*documented*): hook state must live
  outside it (the shared runtime's `~/.openviking/...` paths already do).
- MCP `variables` can prompt the user for an API key (*documented*), but nothing says they
  reach hooks. Using them would split hook and MCP credentials; resolve both through the
  shared `ovcli.conf` loader instead (§4.2 of the standard).

## 3. Events

`hooks.json` top level is a map of named groups; `PreToolUse`/`PostToolUse` take
`[{ "matcher": "<regex>", "hooks": [handler…] }]`, the other events take a flat handler list.
Handler: `{ "type": "command", "command": "…", "timeout": <seconds> }`.

| Event | Fired? | Notes |
| --- | --- | --- |
| `SessionStart` | **verified** | Once per **new** conversation, at its first prompt (payload already has `lastUserInput`). **Not** fired when returning to an existing conversation or after an app restart. |
| `PreInvocation` | **verified** | Before **every** model call, including each step of a tool loop. `invocationNum` counts **from 0** within a turn. |
| `PostInvocation` | **verified** | After every model call. |
| `PreToolUse` | **verified** | Per tool call; `matcher: "*"` matched `run_command`, `read_file`. |
| `PostToolUse` | **verified** | Per tool call. |
| `Stop` | **verified** | Once per turn. Observed `terminationReason: "NO_TOOL_CALL"`, `fullyIdle: true`, `executionNum: 0` on every turn. |
| `UserPromptSubmit`, `SessionEnd`, `PreCompact`, subagent events | **do not exist** | No session-end signal at all. |

Handlers of one event ran **sequentially** (≈45 ms apart) and **block** the agent: a handler
sleeping under a 1 s timeout delayed the following `PreInvocation` by ≈1 s.

## 4. Input (stdin JSON, camelCase)

| Field | SessionStart | Pre/PostInvocation | Pre/PostToolUse | Stop |
| --- | --- | --- | --- | --- |
| `conversationId` | ✓ | ✓ | ✓ | ✓ |
| `transcriptPath` (`…/brain/<id>/.system_generated/logs/transcript_full.jsonl`) | ✓ | ✓ | ✓ | ✓ |
| `workspacePaths` (array) | ✓ | ✓ | ✓ | ✓ |
| `lastUserInput` (clean prompt text, no wrappers) | ✓ | ✓ | ✓ | ✓ |
| `artifactDirectoryPath`, `modelName` | ✓ | ✓ | ✓ | ✓ |
| `invocationNum`, `initialNumSteps` | — | ✓ | — | — |
| `toolCall {name, args}`, `stepIdx` | — | — | ✓ | — |
| `error` | — | — | PostToolUse | ✓ |
| `executionNum`, `terminationReason`, `fullyIdle` | — | — | — | ✓ |

**Consequences for the adapter**

1. There is **no `cwd`**. Use `workspacePaths[0]` as the session cwd for config reload and
   peer resolution; `process.cwd()` is the plugin root and must not be used.
2. `conversationId` is the native session id (UUID); map it to `session_id`.
3. The prompt comes from `lastUserInput`; no transcript read is needed for recall.
4. `PreInvocation` fires for tool-loop continuations with the same `lastUserInput`: recall
   once per user turn and reuse the cached block for later invocations (see §5).

## 5. Output

| Event | Shape | Verified behaviour |
| --- | --- | --- |
| `SessionStart`, `PreInvocation` | `{"injectSteps":[{"ephemeralMessage":"…"}]}` | Injected and recorded in the transcript as `EPHEMERAL_MESSAGE` (`source: "SYSTEM_SDK"`). |
| `PreToolUse` | `{"decision":"allow"\|"deny"\|"ask"\|…, "reason"?}` | ⚠️ **`{}` is a deny** (`tool call denied by pre-tool hook`). Pass-through must be `{"decision":"allow"}`, which kept the normal permission flow. `auto_approve` skips prompts — never a pass-through. |
| `PostInvocation`, `PostToolUse` | `{}` | accepted |
| `Stop` | `{}` | accepted; only `decision: "continue"` would keep the loop running (*documented*) |

**Ephemeral lifetime (verified)**: with tools forbidden, the model reported the marker
injected for the current invocation (appended directly after the user request) and **not**
the marker injected on the previous turn. An `ephemeralMessage` therefore does not survive
into later turns. Whether it survives from invocation 0 into invocation 1 of the same turn is
**pending**; the adapter re-injects the cached recall block on every `PreInvocation` of the
turn so tool-loop calls keep memory either way.

## 6. Exit codes

*documented*: commands must exit 0 and print JSON; a non-zero exit is logged and ignored
(fail open). Not exercised beyond exit 0.

## 7. Time limits and async writes

| Observation | Reading |
| --- | --- |
| A handler sleeping 3 s under `timeout: 1` never logged its post-sleep line | timeout is **enforced by kill** |
| A detached worker spawned by `Stop` logged at 0/5/20/60 s with `ppid 1` | worker **survives** the hook; `maybeDetach` is safe |

## 8. Message source (transcript)

- Two files per conversation under `…/brain/<conversationId>/.system_generated/logs/`:
  `transcript_full.jsonl` (the `transcriptPath`, full content) and `transcript.jsonl`
  (same records, content truncated). Read the full one.
- One JSON record per step: `step_index`, `source`, `type`, `status`, `created_at`,
  `content`, plus `thinking`, `tool_calls`, `error`, token counts where relevant.

| `type` | `source` | Capture |
| --- | --- | --- |
| `USER_INPUT` | `USER_EXPLICIT` | yes — strip `<USER_REQUEST>` wrapper and drop `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` blocks |
| `PLANNER_RESPONSE` | `MODEL` | yes — `content` (final text, may be absent on tool-only steps), `tool_calls: [{name, args}]`; `thinking` excluded |
| `GENERIC` | `MODEL` | tool result text (`Created At:…Command output:…`), `status: "ERROR"` + `error` on denial; pairs with the preceding `tool_calls` in order |
| `EPHEMERAL_MESSAGE` | `SYSTEM_SDK` | **never** — this is injected context, including recalled memory |
| `SYSTEM_MESSAGE` | `SYSTEM` | no — host notices (e.g. "subagents stopped due to server restart") |

- **Flush timing: complete at `Stop`** (**verified**): the copy taken by every `Stop` handler
  already contained that turn's final `PLANNER_RESPONSE`.
- **`step_index` is not unique** (**verified**): after a retried message the file kept the
  old branch and appended a new one starting again at the retried step (`step_index` 4…13
  twice). Append-only file, so track capture progress by **line position**; a `step_index`
  lower than the last captured one marks a new branch, not a duplicate.
- No stable message id exists; dedupe by `(line position, step_index, created_at)`, never by
  text alone.

## 9. Recovery and commit points

- No end event and `SessionStart` is not re-fired on resume, so `Stop` is the only reliable
  write point. Commit at `Stop` (threshold- or turn-based, as ZCode does) and replay the
  pending queue from `SessionStart`/`PreInvocation` of any conversation.
- An app restart re-numbered nothing but injected a `SYSTEM_MESSAGE`; the conversation id
  and transcript file were unchanged.

## 10. Pending

- `invocationNum` 0 → 1 ephemeral survival within one turn.
- MCP: `mcp_config.json` startup cwd, environment inheritance, tool namespace in practice.
- `PreToolUse` `deny` + `reason`: whether the reason reaches the model as the tool result
  (needed for the URI guard).
- `executionNum` / `terminationReason` values other than `0` / `NO_TOOL_CALL`
  (cancellation, errors, max steps).
- Linux, Windows; Antigravity CLI and IDE.

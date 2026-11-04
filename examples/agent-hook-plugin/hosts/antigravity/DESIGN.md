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

**Second pass** (same App 2.28.2, model `gemini-3.8-flash-high`, macOS darwin 25.4.0,
2026-11-04): three probe rounds against the §10 pending items — unique random markers per
injection, tools forbidden when asking the model what it sees, and every conclusion about
cross-turn visibility drawn only from markers the model had not echoed before (an echoed marker
stays visible through the model's own earlier reply). Covered: `systemMessage` delivery and
persistence, ephemeral lifetime, deny `reason`, MCP startup and tool namespace, queued messages,
a cancelled turn.

Legend: **verified** = observed in a real session · *documented* = only in the host docs
(`antigravity.google/docs/hooks`, `/docs/build-plugins`, `/docs/plugins`, and the copy the App
ships at `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md`) ·
**pending** = not reproduced.

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
| MCP file | `mcp_config.json` at the root, `mcpServers` map; server registered as `<plugin>_<server>` (**verified**, see below) |
| Validation | `agy plugin validate <dir>` (CLI 1.0.16) checks manifest, hooks and MCP config; it takes no `--strict` flag (**verified**) |

- Hook commands run with **cwd = plugin root** (**verified**), so commands use relative paths
  (`node ./scripts/hook.mjs …`). Absolute paths are unnecessary and unportable.
- `PLUGIN_ROOT` / `PLUGIN_DATA` are **not** exported to hook processes (**verified**: no
  `PLUGIN_*` keys in the hook environment). They are *documented* for MCP `args`/`cwd`/`env`.
- The plugin root is read-only and replaced on update (*documented*): hook state must live
  outside it (the shared runtime's `~/.openviking/...` paths already do).
- MCP servers (**verified**): started with **cwd = plugin root**; `${PLUGIN_ROOT}` in `args`
  is expanded to the absolute plugin root; the server inherits the login-shell environment plus
  `PLUGIN_ROOT`, `PLUGIN_DATA` (`~/.gemini/antigravity/plugin_data/<plugin>`) and the `env`
  entries from `mcp_config.json`. The client sends `server/discover`, then `initialize` with
  `protocolVersion: "2025-11-25"`, `notifications/initialized`, `tools/list`; `tools/call`
  carries `_meta` keys `antigravity.google/artifacts_dir` and `antigravity.google/conversa…`.
- The model does **not** get one tool per MCP tool. It calls a generic built-in tool
  `call_mcp_tool {ServerName: "<plugin>_<server>", ToolName, Arguments}`, and first reads the
  tool's schema with `read_file` from `~/.gemini/antigravity/mcp/<plugin>_<server>/<tool>.json`.
  For this plugin: `ServerName: "openviking-memory_openviking"`. Both calls pass through
  `PreToolUse`; a guard must keep allowing those schema reads (they are local paths).
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
| `Stop` | **verified** | Once per completed turn. Observed `terminationReason: "NO_TOOL_CALL"` and `executionNum: 0` on every turn; `fullyIdle: false` when the user had already queued the next message (the doc describes it as "all background tasks are done"). **Not fired for a turn the user cancels** (twice, see below). |
| `UserPromptSubmit`, `SessionEnd`, `PreCompact`, subagent events | **do not exist** | No session-end signal at all. |

Handlers of one event ran **sequentially** (≈45 ms apart) and **block** the agent: a handler
sleeping under a 1 s timeout delayed the following `PreInvocation` by ≈1 s.

**Cancelled turn (verified twice)**: pressing stop while the model was generating left a
`PreInvocation` with no `PostInvocation` and no `Stop`; the transcript kept the turn's
`USER_INPUT` and, for a cancelled background task, a later host `SYSTEM_MESSAGE`
("Task id … was canceled"). The documented `terminationReason: "USER_CANCELED"` was never
delivered. Records of a cancelled turn are therefore captured by the next `Stop` of that
conversation, or not at all if the conversation is never continued.

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
   and inject once per user turn, at `invocationNum` 0 (see §5).
5. **Queued messages (verified)**: when the user sends a message while the previous turn is
   still running, that message's `PreInvocation` with `invocationNum: 0` still carries the
   **previous** turn's `lastUserInput`; the new text appears from `invocationNum: 1` on. The
   transcript does not have it yet either: its `USER_INPUT` record is written after the
   ephemeral injected at invocation 0, and the model sees that ephemeral placed before the new
   request. A message sent after the previous turn finished had the correct `lastUserInput`
   at invocation 0 (three turns). A queued message therefore gets the previous message's
   recall when its turn has no tool call; the previous `Stop` reporting `fullyIdle: false`
   is the only signal that a message was queued.

## 5. Output

| Event | Shape | Verified behaviour |
| --- | --- | --- |
| `SessionStart`, `PreInvocation` | `{"injectSteps":[{"ephemeralMessage":"…"}]}` | Injected and recorded in the transcript as `EPHEMERAL_MESSAGE` (`source: "SYSTEM_SDK"`). |
| `SessionStart` | `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}` — a **nested object** | Injected and recorded as `SYSTEM_MESSAGE` (`source: "SYSTEM_SDK"`), wrapped by the host as "The following system message was injected by a SessionStart hook: …". **Persists across turns** (verified on turn 3 with a marker the model had not echoed). The UI shows it as a collapsible "System Message" row (*documented*: `metadata.user_markdown` changes that). |
| `PreToolUse` | `{"decision":"allow"\|"deny"\|"ask"\|"force_ask", "reason"?, "permissionOverrides"?, "overwrite"?}` | ⚠️ **`{}` is a deny** (`tool call denied by pre-tool hook`). Pass-through must be `{"decision":"allow"}`, which kept the normal permission flow. `auto_approve` skips prompts — never a pass-through. A deny's `reason` **reaches the model**: the tool result is `Encountered error in step execution: tool call denied by pre-tool hook: <reason>` (`GENERIC`, `status: "ERROR"`), and the model quoted it verbatim (**verified**). |
| `PostInvocation`, `PostToolUse` | `{}` | accepted |
| `Stop` | `{}` | accepted; only `decision: "continue"` would keep the loop running (*documented*) |

⚠️ **A malformed step drops the whole output, silently** (**verified**): a plain-string
`systemMessage` was not delivered, and an `ephemeralMessage` sent in the same `injectSteps`
array was dropped with it — no transcript record, nothing visible to the model, nothing in the
host's logs. Only send step shapes listed above; test any new one in the App.

**Ephemeral lifetime (verified)**:
- **Within a turn it survives**: at invocation 1 the model quoted the marker injected at
  invocation 0 of the same turn, which it had not echoed before. Injecting at every invocation
  would therefore stack copies of the same block in a tool loop; inject once, at
  `invocationNum` 0.
- **It does not survive into later turns**: on turn 3 the model reported none of the markers
  injected on turns 1–2 (none of them echoed), while it did report the `systemMessage` from
  `SessionStart`. A marker the model echoed in a reply stays visible only through that reply.

Placement: the model sees the ephemeral appended right after the current user request (or
right before it, for a queued message — §4).

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
| `SYSTEM_MESSAGE` | `SYSTEM_SDK` | **never** — a hook-injected `systemMessage`, i.e. the profile |
| `SYSTEM_MESSAGE` | `SYSTEM` | no — host notices (e.g. "subagents stopped due to server restart", "Task id … was canceled") |

- A tool the host moves to the background (`run_command` with a long command) produces a
  `GENERIC` with `status: "RUNNING"` ("Tool is running as a background task with task id …"),
  and the turn ends with a normal `Stop`; completion or cancellation arrives later as a host
  `SYSTEM_MESSAGE`.
- MCP calls appear as `PLANNER_RESPONSE.tool_calls[{name: "call_mcp_tool", args: {ServerName,
  ToolName, Arguments}}]` followed by a `GENERIC` holding the tool's text output.
- `PLANNER_RESPONSE` records also carry `input_tokens`, `cache_read_tokens`, `output_tokens`.
- Record order is not `created_at` order: a queued message's `USER_INPUT` (created when the
  user sent it) is written after its turn's first `EPHEMERAL_MESSAGE`.

- **Flush timing: complete at `Stop`** (**verified**): the copy taken by every `Stop` handler
  already contained that turn's final `PLANNER_RESPONSE`.
- **`step_index` is not unique** (**verified**): after a retried message the file kept the
  old branch and appended a new one starting again at the retried step (`step_index` 4…13
  twice). Append-only file, so track capture progress by **line position**; a `step_index`
  lower than the last captured one marks a new branch, not a duplicate. The App's
  **"Undo to this point" + re-send** behaves the same (**verified** twice): the old lines stay
  and the re-sent branch is appended with the undone `step_index` values. It also **rewinds
  `initialNumSteps`**, so the re-sent message's first `PreInvocation` repeats the undone turn's
  `initialNumSteps`; never use it as a turn or event id.
- No stable message id exists; dedupe by `(line position, step_index, created_at)`, never by
  text alone.

## 9. Recovery and commit points

- No end event and `SessionStart` is not re-fired on resume, so `Stop` is the only reliable
  write point. Commit at `Stop` (threshold- or turn-based, as ZCode does) and replay the
  pending queue from `SessionStart`/`PreInvocation` of any conversation.
- An app restart re-numbered nothing but injected a `SYSTEM_MESSAGE`; the conversation id
  and transcript file were unchanged.

## 10. Pending

- `executionNum` / `terminationReason` values other than `0` / `NO_TOOL_CALL` (errors, max
  invocations). A cancelled turn sends no `Stop` at all (§3).
- Ephemeral survival beyond invocation 1 of a turn (verified only 0 → 1).
- Linux, Windows; Antigravity CLI and IDE.

Resolved in the second pass: ephemeral survival within a turn and across turns (§5),
`systemMessage` shape and persistence (§5), deny `reason` visibility (§5), MCP startup, cwd,
environment and tool namespace (§2), cancellation (§3), queued messages (§4).

## 11. Acceptance (installed plugin)

The `antigravity` bundle 0.5.30, installed by `install.sh --harness antigravity --source dev`
from `feat/antigravity-host`, was exercised in Antigravity App 2.28.2 (`gemini-3.8-flash-high`,
macOS darwin 25.4.0) against an OpenViking v0.5.2.1 server on 2026-11-04. One conversation,
five turns plus two undo-and-resend rounds:

| Check | Observation |
| --- | --- |
| Profile | `SessionStart` wrote a `SYSTEM_MESSAGE` (`SYSTEM_SDK`) holding `<openviking-context source="session-start">`; on turn 3, with tools forbidden, the model quoted it — persisted across turns |
| Recall | One `EPHEMERAL_MESSAGE` per turn, none at `invocationNum` ≥ 1 (7-call tool loop on turn 5); on turn 3 only that turn's recall block was in context; turn 1's answer used recalled project memory |
| URI guard | `read_file viking://~/memories` denied; the model quoted the reason, including "Use OpenViking MCP read instead" |
| MCP | The model read the schemas under `~/.gemini/antigravity/mcp/openviking-memory_openviking/`, then `call_mcp_tool` `find`/`search` returned results |
| Capture | All turns reached session `ag-<conversationId>`: user and assistant text plus `[tool-call …]`/`[tool-result …]` for `run_command`, `read_file` (including the deny error) and `call_mcp_tool`; no injected profile or recall block was re-captured |
| Commit | One accepted commit per completed turn (7 in all); `capturedSinceCommit` back to 0 after each |
| Undo + re-send | Only the appended branch was sent, once. The first round found the re-sent message without recall (prompt event id built from the rewound `initialNumSteps`; fixed in `6cfebc43b`); the second round had its `EPHEMERAL_MESSAGE` |
| Host notice | The restart `SYSTEM_MESSAGE` (`SYSTEM`) was skipped |

The hook log file was not written: debug logging is off by default, so the evidence is the
transcript, the hook state file and the server session.

/**
 * Adapter tests for the Antigravity host: guard decisions, input normalization,
 * prompt gating, injection envelopes, and transcript capture driven through the hook dispatcher.
 *
 * Purpose: Verifies Antigravity's PreToolUse allow/deny decisions, injectSteps envelopes,
 * once-per-turn recall at invocationNum 0, cached recall block reuse on queued prompts,
 * and reliable turn capture and commit on Stop.
 * Usage: Run with `node --test examples/agent-hook-plugin/tests/antigravity.test.mjs`.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  expectExit,
  readRequestBody,
  runHookScript,
  scrubOpenVikingEnv,
  withMockOpenViking,
  writeCredentialFiles,
  writeJson,
} from "../../memory-plugin-shared/testing/support.mjs";
import { antigravity } from "../hosts/antigravity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "hook.mjs");

// ---------------------------------------------------------------------------
// Guard and envelope tests
// ---------------------------------------------------------------------------

test("pre-tool-use never answers {}", () => {
  const allowCmd = antigravity.guard({
    toolCall: { name: "run_command", args: { CommandLine: "ls" } },
  });
  assert.deepEqual(allowCmd, { decision: "allow" });

  const allowEmpty = antigravity.guard({});
  assert.deepEqual(allowEmpty, { decision: "allow" });
});

test("read_file on a viking URI is denied", () => {
  const res = antigravity.guard({
    toolCall: { name: "read_file", args: { Path: "viking://~/memories/x.md" } },
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /OpenViking MCP read/);
});

test("envelopes use injectSteps", () => {
  const pre = antigravity.envelope("pre-invocation", "B");
  assert.deepEqual(pre, { injectSteps: [{ ephemeralMessage: "B" }] });

  const start = antigravity.envelope("session-start", "P");
  assert.deepEqual(start, {
    injectSteps: [{ systemMessage: { systemMessage: "P" } }],
  });

  assert.deepEqual(antigravity.envelope("stop", ""), {});
  assert.deepEqual(antigravity.envelope("pre-invocation", ""), {});
});

test("normalizeInput maps conversationId and sets no prompt event id", () => {
  // Undo-and-resend rewinds initialNumSteps, so an id built from it would mark the
  // re-sent message as a duplicate event and skip its recall.
  const norm = antigravity.normalizeInput({ conversationId: "c", initialNumSteps: 5 });
  assert.equal(norm.session_id, "c");
  assert.equal(norm.prompt_id, undefined);
});

// ---------------------------------------------------------------------------
// Hook dispatcher tests with mock server
// ---------------------------------------------------------------------------

/** Wait past the dispatcher's 500 ms same-prompt duplicate window, as a real next turn does. */
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 600));

async function createSandbox(prefix = "ov-ag-test-") {
  const files = await writeCredentialFiles(prefix, {
    ovcli: { url: "http://127.0.0.1:1", api_key: "k" },
    ov: {},
  });
  return {
    files,
    env: {
      OPENVIKING_MEMORY_ENABLED: "1",
      OPENVIKING_WRITE_PATH_ASYNC: "0",
      OPENVIKING_HOOK_STATE_DIR: join(files.dir, "hook-state"),
      OPENVIKING_PENDING_DIR: join(files.dir, "pending"),
      OPENVIKING_STATE_DIR: join(files.dir, "state"),
    },
  };
}

test("pre-invocation injects only at invocation 0 and cached block is reused", async () => {
  const restoreEnv = scrubOpenVikingEnv();
  const box = await createSandbox("ov-ag-pre-inv-");
  let searchCalls = 0;

  try {
    await withMockOpenViking(async (req, res) => {
      const { pathname } = new URL(req.url, "http://127.0.0.1");
      if (pathname.endsWith("/search/search") || pathname.endsWith("/search/find")) {
        searchCalls++;
        return writeJson(res, {
          status: "ok",
          result: {
            rendered: "recalled content",
            entries: [{ uri: "viking://~/memories/1.md", text: "recalled content" }],
          },
        });
      }
      return writeJson(res, { status: "ok" });
    }, async (url) => {
      const files = await writeCredentialFiles("ov-ag-pre-inv-url-", {
        ovcli: { url, api_key: "k" },
        ov: {},
      });
      try {
        const baseInput = {
          conversationId: "conv-1",
          workspacePaths: [box.files.dir],
        };

        // 1. Invocation 0 -> should recall and inject ephemeralMessage
        const r0 = await runHookScript(HOOK, {
          argv: ["pre-invocation", "antigravity"],
          input: {
            ...baseInput,
            lastUserInput: "q",
            initialNumSteps: 1,
            invocationNum: 0,
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r0, 0);
        const out0 = JSON.parse(r0.stdout.trim());
        assert.ok(out0.injectSteps?.[0]?.ephemeralMessage, "stdout has ephemeralMessage");
        const searchAfter0 = searchCalls;
        assert.ok(searchAfter0 >= 1, "mock saw search request");

        // 2. Invocation 1 -> prompt() returns "", should return {} and no new search
        const r1 = await runHookScript(HOOK, {
          argv: ["pre-invocation", "antigravity"],
          input: {
            ...baseInput,
            lastUserInput: "q",
            initialNumSteps: 3,
            invocationNum: 1,
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r1, 0);
        assert.deepEqual(JSON.parse(r1.stdout.trim()), {});
        assert.equal(searchCalls, searchAfter0, "mock saw no search request during invocation 1");

        // 3. Next turn with same lastUserInput (queued message) -> reuses cached block without search.
        //    A real turn lasts at least one model call, so the next turn starts well outside the
        //    dispatcher's 500 ms same-prompt duplicate window; wait past it.
        await nextTurn();
        const r2 = await runHookScript(HOOK, {
          argv: ["pre-invocation", "antigravity"],
          input: {
            ...baseInput,
            lastUserInput: "q",
            initialNumSteps: 6,
            invocationNum: 0,
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r2, 0);
        const out2 = JSON.parse(r2.stdout.trim());
        assert.deepEqual(out2, out0, "reuses the cached ephemeralMessage block");
        assert.equal(searchCalls, searchAfter0, "mock saw no search request during cached replay");

        // 4. Pre-invocation without lastUserInput -> silent {}
        const r3 = await runHookScript(HOOK, {
          argv: ["pre-invocation", "antigravity"],
          input: {
            ...baseInput,
            initialNumSteps: 7,
            invocationNum: 0,
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r3, 0);
        assert.deepEqual(JSON.parse(r3.stdout.trim()), {});
        assert.equal(searchCalls, searchAfter0, "mock saw no search request without lastUserInput");

        // 5. Undo-and-resend: the re-sent message replays the rewound initialNumSteps (6)
        //    at invocation 0 and must still get its recall block.
        await nextTurn();
        const r4 = await runHookScript(HOOK, {
          argv: ["pre-invocation", "antigravity"],
          input: {
            ...baseInput,
            lastUserInput: "q",
            initialNumSteps: 6,
            invocationNum: 0,
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r4, 0);
        assert.deepEqual(JSON.parse(r4.stdout.trim()), out0, "re-sent message after undo gets the recall block");
      } finally {
        await rmSync(files.dir, { recursive: true, force: true });
      }
    });
  } finally {
    restoreEnv();
    await rmSync(box.files.dir, { recursive: true, force: true });
  }
});

test("stop captures user, assistant and tool turns, then commits", async () => {
  const restoreEnv = scrubOpenVikingEnv();
  const box = await createSandbox("ov-ag-stop-");
  const transcriptPath = join(box.files.dir, "transcript_full.jsonl");

  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>Search and run</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "call_mcp_tool",
          args: {
            ServerName: "openviking-memory_openviking",
            ToolName: "search",
            Arguments: { query: "x" },
          },
        },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      content: "MCP search result text",
      status: "COMPLETED",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: "long running process" },
        },
      ],
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "GENERIC",
      content: "Tool is running as a background task with task id 123",
      status: "RUNNING",
    },
  ];
  writeFileSync(transcriptPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const seen = { batches: [], commit: 0, sessions: [] };

  try {
    await withMockOpenViking(async (req, res) => {
      const { pathname } = new URL(req.url, "http://127.0.0.1");
      if (pathname.includes("/messages")) {
        const body = await readRequestBody(req);
        seen.batches.push(body);
        const match = pathname.match(/\/sessions\/([^/]+)\//);
        if (match) seen.sessions.push(match[1]);
        return writeJson(res, { status: "ok", data: { added: 2 } });
      }
      if (pathname.endsWith("/commit")) {
        seen.commit++;
        return writeJson(res, { status: "ok", trace_id: "t" });
      }
      return writeJson(res, { status: "ok" });
    }, async (url) => {
      const files = await writeCredentialFiles("ov-ag-stop-url-", {
        ovcli: { url, api_key: "k" },
        ov: {},
      });
      try {
        const stopInput = {
          conversationId: "c-stop-1",
          transcriptPath,
          workspacePaths: [box.files.dir],
        };

        // First Stop
        const r1 = await runHookScript(HOOK, {
          argv: ["stop", "antigravity"],
          input: stopInput,
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r1, 0);

        assert.equal(seen.batches.length, 1);
        assert.equal(seen.commit, 1);
        assert.ok(seen.sessions.every((s) => s.startsWith("ag-")));
        const msgs = seen.batches[0].messages;
        assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);

        // Second identical Stop -> capture with no new records returns null, no new requests
        const r2 = await runHookScript(HOOK, {
          argv: ["stop", "antigravity"],
          input: stopInput,
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r2, 0);

        assert.equal(seen.batches.length, 1, "no second message batch sent");
        assert.equal(seen.commit, 1, "no second commit sent");

        // Unreadable transcript does not advance state
        const stateFile = join(box.env.OPENVIKING_HOOK_STATE_DIR, "antigravity", "c-stop-1.json");
        const stateBefore = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;

        const r3 = await runHookScript(HOOK, {
          argv: ["stop", "antigravity"],
          input: {
            ...stopInput,
            transcriptPath: "/nonexistent/path/transcript.jsonl",
          },
          cwd: box.files.dir,
          env: { ...files.env, ...box.env },
        });
        expectExit(r3, 0);

        const stateAfter = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
        assert.equal(stateAfter?.lastTurnId, stateBefore?.lastTurnId, "lastTurnId was not modified");
      } finally {
        await rmSync(files.dir, { recursive: true, force: true });
      }
    });
  } finally {
    restoreEnv();
    await rmSync(box.files.dir, { recursive: true, force: true });
  }
});

/**
 * Unit tests for the Antigravity transcript decoder (antigravity-turns.mjs).
 * Purpose: Verifies decoding of Antigravity transcript JSONL logs into normalized
 * user and assistant capture turns (one assistant turn per model step, each with
 * structured text/tool `parts` in the server's vocabulary), stripping host metadata
 * wrappers, preserving tool calls and results, ignoring ephemeral/system messages,
 * and tracking line-based cursors.
 * Usage: Run with `node --test examples/agent-hook-plugin/tests/antigravity-turns.test.mjs`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  antigravityUserText,
  buildAntigravityTurns,
  cleanAntigravityText,
  extractAntigravityTurns,
} from "../hosts/antigravity-turns.mjs";

test("user turn strips host blocks", () => {
  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nReply with just OK.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-04T07:40:30+07:00.\n</ADDITIONAL_METADATA>",
    },
  ];
  const turns = extractAntigravityTurns(records);
  assert.deepEqual(turns, [
    {
      role: "user",
      content: "Reply with just OK.",
      parts: [{ type: "text", text: "Reply with just OK." }],
      turnId: "0",
    },
  ]);
});

test("metadata-only user input yields no turn", () => {
  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>\n\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>",
    },
  ];
  const turns = extractAntigravityTurns(records);
  assert.deepEqual(turns, []);
});

test("ephemeral and system records are never captured", () => {
  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>Hi</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "SYSTEM_SDK",
      type: "EPHEMERAL_MESSAGE",
      content: "[marker]",
    },
    {
      step_index: 2,
      source: "SYSTEM_SDK",
      type: "SYSTEM_MESSAGE",
      content: "profile",
    },
    {
      step_index: 3,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: "notice",
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "OK",
    },
  ];
  const turns = extractAntigravityTurns(records);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  for (const t of turns) {
    assert.ok(!t.content.includes("[marker]"), "marker should not be in content");
    assert.ok(!t.content.includes("profile"), "profile should not be in content");
    assert.ok(!t.content.includes("notice"), "notice should not be in content");
  }
});

test("background and MCP tool calls are captured", () => {
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
  const turns = extractAntigravityTurns(records);
  assert.deepEqual(turns.map((t) => [t.role, t.turnId]), [["user", "0"], ["assistant", "1"], ["assistant", "3"]]);
  assert.ok(turns[1].content.includes("[tool-call call_mcp_tool]"), "contains call_mcp_tool call");
  assert.ok(
    turns[1].content.includes("[tool-result call_mcp_tool] MCP search result text"),
    "contains the MCP result output",
  );
  assert.ok(
    turns[2].content.includes("[tool-result run_command] Tool is running as a background task with task id 123"),
    "contains RUNNING result text",
  );
  const backgroundResult = turns[2].parts.find((p) => p.type === "tool" && p.tool_output !== undefined);
  assert.equal(backgroundResult.tool_status, "running", "a backgrounded tool stays running");
  const mcpResult = turns[1].parts.find((p) => p.type === "tool" && p.tool_output !== undefined);
  assert.equal(mcpResult.tool_status, "completed", "host statuses map to the server vocabulary");
});

test("each model step is one assistant turn with structured tool parts", () => {
  const records = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>Go</USER_REQUEST>" },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Listing.",
      tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
    },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "a\nb" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Done." },
  ];
  const turns = extractAntigravityTurns(records);
  assert.deepEqual(turns.map((t) => [t.role, t.turnId]), [["user", "0"], ["assistant", "1"], ["assistant", "3"]]);
  assert.deepEqual(turns[1].parts, [
    { type: "text", text: "Listing." },
    { type: "tool", tool_id: "1:0", tool_name: "run_command", tool_status: "running", tool_input: { CommandLine: "ls" } },
    { type: "tool", tool_id: "1:0", tool_name: "run_command", tool_status: "completed", tool_output: "a\nb" },
  ]);
  assert.deepEqual(turns[2].parts, [{ type: "text", text: "Done." }]);
  for (const turn of turns) {
    assert.ok(
      !turn.parts.some((p) => p.type === "text" && /\[tool-(call|result)/.test(p.text)),
      "tool activity is never flattened into a text part",
    );
  }
});

test("tool calls and results attach to the assistant turn", () => {
  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>List and read</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [
        { name: "run_command", args: { CommandLine: "ls" } },
        { name: "read_file", args: { Path: "/r/README.md" } },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      content: "file1\nfile2",
      status: "COMPLETED",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      status: "ERROR",
      error: "tool call denied by pre-tool hook: URI forbidden",
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "done",
    },
  ];
  const turns = extractAntigravityTurns(records);
  assert.deepEqual(turns.map((t) => [t.role, t.turnId]), [["user", "0"], ["assistant", "1"], ["assistant", "4"]]);
  assert.equal(turns[2].content, "done", "the next model step is its own turn");
  const assistantTurn = turns[1];
  const content = assistantTurn.content;
  assert.ok(content.includes("[tool-call run_command]"));
  assert.ok(content.includes("[tool-call read_file]"));
  assert.ok(content.includes("[tool-result run_command] file1"), "completed output is captured");
  assert.ok(content.includes("file2"), "completed output is captured in full");
  assert.ok(
    content.includes("[tool-result read_file] tool call denied by pre-tool hook: URI forbidden"),
    "a denied call is captured with its error",
  );
  assert.ok(
    content.indexOf("[tool-call run_command]") < content.indexOf("[tool-result run_command]"),
    "parts keep transcript order",
  );
  const results = assistantTurn.parts.filter((p) => p.type === "tool" && p.tool_output !== undefined);
  assert.deepEqual(
    results.map((p) => [p.tool_name, p.tool_status, p.tool_output]),
    [
      ["run_command", "completed", "file1\nfile2"],
      ["read_file", "error", "tool call denied by pre-tool hook: URI forbidden"],
    ],
  );
});

test("thinking is dropped", () => {
  const records = [
    {
      step_index: 0,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "A",
      thinking: "secret plan",
    },
  ];
  const turns = extractAntigravityTurns(records);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, "A");
  assert.ok(!turns[0].content.includes("secret plan"));
});

test("retried branch yields only new line ids", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ag-retry-test-"));
  const transcriptPath = join(tmpDir, "transcript_full.jsonl");
  try {
    const lines = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>Try 1</USER_REQUEST>" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "Response 1" }),
      JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>Try 2</USER_REQUEST>" }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "Response 2" }),
      JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>Retry 2</USER_REQUEST>" }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "Retry Response 2" }),
    ];
    writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

    const result = buildAntigravityTurns({ transcriptPath }, { lastTurnId: "3" });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.turns.map((t) => t.turnId), ["4", "5"]);
    assert.equal(result.turns[0].content, "Retry 2");
    assert.equal(result.turns[1].content, "Retry Response 2");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("missing and unreadable transcripts are statuses, not empty success", () => {
  const missing = buildAntigravityTurns({});
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.turns, []);

  const unreadable = buildAntigravityTurns({ transcriptPath: "/nonexistent/path/transcript.jsonl" });
  assert.equal(unreadable.status, "unreadable");
  assert.deepEqual(unreadable.turns, []);
});

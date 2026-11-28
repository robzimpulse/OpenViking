/**
 * Unit tests for the shared incremental turn capture plan (hosts/incremental-turn-capture.mjs).
 * Purpose: pins how a decoded turn becomes a session message payload — text-only turns
 * keep the `content` string, and a turn that carries structured `parts` sends them so the
 * server stores tool calls/results as `tool` parts instead of one text part.
 * Usage: `node --test examples/agent-hook-plugin/tests/incremental-turn-capture.test.mjs`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildIncrementalCapturePlan } from "../hosts/incremental-turn-capture.mjs";

test("a text-only turn is sent as content", () => {
  const plan = buildIncrementalCapturePlan([{ role: "user", content: "Please refactor the router", turnId: "0" }]);
  assert.deepEqual(plan.payloads, [{ role: "user", content: "Please refactor the router", turn_id: "0" }]);
});

test("a turn with structured parts sends them", () => {
  const parts = [
    { type: "text", text: "Listing the workspace now." },
    { type: "tool", tool_id: "1:0", tool_name: "run_command", tool_status: "running", tool_input: { CommandLine: "ls" } },
  ];
  const plan = buildIncrementalCapturePlan([
    { role: "assistant", content: "Listing the workspace now.\n\n[tool-call run_command] {\"CommandLine\":\"ls\"}", parts, turnId: "1" },
  ]);
  assert.equal(plan.payloads.length, 1);
  assert.deepEqual(plan.payloads[0].parts, parts);
  assert.equal(plan.payloads[0].role, "assistant");
});

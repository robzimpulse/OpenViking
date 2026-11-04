/**
 * Antigravity thin host adapter.
 *
 * Key host facts shaping this adapter (see DESIGN.md):
 * 1. PreToolUse: `{}` is treated by the host as a deny ("tool call denied by pre-tool hook").
 *    Pass-through must always explicitly return `{"decision":"allow"}`.
 * 2. Ephemeral messages: an `ephemeralMessage` survives across model invocations within a single turn,
 *    but does not survive into later turns. Therefore recall is injected once per turn at `invocationNum === 0`.
 *    A nested `systemMessage` at SessionStart persists across turns.
 *
 * Purpose: Provides lifecycle stage mappings, input normalization, once-per-turn prompt recall,
 * URI guard allow/deny decisions, and transcript capture + commit on Stop for Google Antigravity.
 * Usage: Loaded by hook dispatcher (`hook.mjs`) and uri-guard (`uri-guard.mjs`) via HOSTS.antigravity.
 */

import { addAgentMessages, commitAgentSession } from "../../memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { evaluateUriGuard } from "../../memory-plugin-shared/lib/uri-guard.mjs";
import {
  applyIncrementalCaptureResult,
  buildIncrementalCapturePlan,
} from "./incremental-turn-capture.mjs";
import { buildAntigravityTurns, cleanAntigravityText } from "./antigravity-turns.mjs";

/**
 * Build host response envelope for injected context.
 * SessionStart injects nested systemMessage; PreInvocation injects ephemeralMessage.
 */
export function envelope(event, block) {
  if (!block) return {};
  if (event === "session-start") {
    return { injectSteps: [{ systemMessage: { systemMessage: block } }] };
  }
  if (event === "pre-invocation") {
    return { injectSteps: [{ ephemeralMessage: block }] };
  }
  return {};
}

/**
 * Normalize input payload fields: map Antigravity's conversationId to session_id.
 * No prompt event id is set: Antigravity has no per-turn id, and one built from
 * initialNumSteps repeats after "Undo to this point" + re-send, which made the dispatcher
 * skip the re-sent message's recall as a duplicate. prompt() already limits recall to
 * invocation 0, so the dispatcher's own same-prompt-within-500ms check is enough.
 */
export function normalizeInput(input = {}) {
  const conversationId = input.conversationId || input.conversation_id;
  const out = { ...input };
  if (!out.session_id && conversationId) {
    out.session_id = conversationId;
  }
  return out;
}

/**
 * Extract prompt text for recall.
 * Returns empty string for invocationNum > 0 (ephemeral already visible in turn)
 * or when lastUserInput is missing.
 */
export function prompt(input = {}) {
  const invocationNum = input.invocationNum ?? input.invocation_num ?? 0;
  if (Number(invocationNum) > 0) return "";
  const raw = input.lastUserInput ?? input.last_user_input;
  if (typeof raw !== "string" || !raw.trim()) return "";
  return cleanAntigravityText(raw.trim());
}

/**
 * PreToolUse URI guard for Antigravity.
 * Denies read_file on viking:// URIs; always returns decision: "allow" when not denying (never {}).
 */
export function guard(input = {}) {
  const call = input.toolCall || input.tool_call;
  const name = call?.name || input.toolName || input.tool_name;
  if (name === "read_file") {
    const match = evaluateUriGuard("read", call?.args || call?.arguments || {});
    if (match) {
      return { decision: "deny", reason: match.reason };
    }
  }
  return { decision: "allow" };
}

/**
 * Capture conversation turns from transcript and commit after turn completion.
 */
export async function capture(ctx, state) {
  const transcript = buildAntigravityTurns(ctx.input, state, ctx.cfg);
  if (transcript.status !== "ok") {
    ctx.log(`capture_${transcript.status}`, transcript.error ? { error: transcript.error } : {});
    return null;
  }
  const plan = buildIncrementalCapturePlan(transcript.turns, state, ctx.cfg);
  if (plan.toSend.length === 0) return null;

  const result = await addAgentMessages(ctx.fetchJSON, ctx.sessionId, plan.payloads, ctx.peerId);
  const { captured, ...nextState } = applyIncrementalCaptureResult(state, plan, result, cleanAntigravityText);
  let capturedSinceCommit = Number(state.capturedSinceCommit || 0) + captured;
  if (captured > 0) {
    const committed = await commitAgentSession(ctx.fetchJSON, ctx.sessionId, ctx.log);
    if (committed.ok || committed.pendingQueued) {
      capturedSinceCommit = 0;
    }
  }
  return { ...nextState, capturedSinceCommit };
}

export const antigravity = {
  prefix: "ag-",
  tracksPendingPrompt: true,
  capturesOnlyWhenEnabled: true,
  detachesCapture: true,
  requestBudgets: {
    "session-start": 25_000,
    "pre-invocation": 17_000,
    stop: 25_000,
  },
  stages: {
    "session-start": "start",
    "pre-invocation": "prompt",
    stop: "capture",
  },
  envelope,
  normalizeInput,
  prompt,
  guard,
  capture,
};

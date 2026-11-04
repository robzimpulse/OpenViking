/**
 * Decode Google Antigravity transcripts (transcript_full.jsonl) into normalized turns.
 *
 * Purpose: Parses JSONL transcript records from Antigravity sessions into user and
 * assistant capture turns, stripping host metadata wrappers (<USER_REQUEST>, <ADDITIONAL_METADATA>),
 * pairing tool calls and results, skipping ephemeral/system injections, and tracking line-based turn IDs.
 * Usage: Called by the Antigravity host adapter during Stop lifecycle events to capture conversation turns.
 */

import { readFileSync } from "node:fs";

import {
  collectToolNamesByIdFromEntries,
  extractTextFromPayload,
  normalizeCaptureRole,
  sanitizeCapturedText,
} from "../../memory-plugin-shared/lib/capture-utils.mjs";

/** Parse JSONL lines into an array of object records. */
export function parseTranscript(content) {
  const records = [];
  for (const line of String(content || "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    records.push(record);
  }
  return records;
}

/** Sanitize captured text using shared utilities. */
export function cleanAntigravityText(value) {
  return sanitizeCapturedText(value == null ? "" : String(value));
}

/**
 * Extract clean user ask text from Antigravity's USER_INPUT content.
 * Extracts inner text of <USER_REQUEST>...</USER_REQUEST> and strips any
 * metadata blocks like <ADDITIONAL_METADATA> or <USER_SETTINGS_CHANGE>.
 * Returns "" if absent or empty.
 */
export function antigravityUserText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const match = raw.match(/<USER_REQUEST\b[^>]*>([\s\S]*?)<\/USER_REQUEST>/i);
  if (!match) return "";
  let inner = match[1];
  inner = inner.replace(/<[A-Za-z0-9_-]+(?:\s[^>]*)?>[\s\S]*?<\/[A-Za-z0-9_-]+>/g, "");
  return inner.trim();
}

/**
 * Extract user and assistant turns from parsed Antigravity records.
 * Purpose: each turn keeps its text, tool calls and tool results (outputs and errors) as
 * content blocks in transcript order, rendered by the shared `extractTextFromPayload`
 * (`[tool-call name] …` / `[tool-result name] …`), so the server receives the tool activity
 * and the shared capture filter recognises tool-only turns.
 * Usage: `extractAntigravityTurns(parseTranscript(raw), cfg)`; turn IDs are the opening
 * record index, and `cfg.captureAssistantTurns === false` drops assistant turns.
 */
export function extractAntigravityTurns(records, cfg = {}) {
  const collected = [];
  let current = null;

  const flush = () => {
    if (current && current.blocks.length > 0) {
      collected.push(current);
    }
    current = null;
  };

  (records || []).forEach((record, index) => {
    const type = String(record?.type || "");
    const source = String(record?.source || "");

    // Ignore injected ephemeral and system messages completely
    if (type === "EPHEMERAL_MESSAGE" || type === "SYSTEM_MESSAGE") {
      return;
    }

    if (type === "USER_INPUT") {
      if (source !== "USER_EXPLICIT") return;
      const ask = antigravityUserText(record.content);
      if (!ask) return;
      flush();
      current = {
        role: "user",
        blocks: [{ type: "text", text: ask }],
        recordIndex: index,
      };
      flush();
      return;
    }

    if (type === "PLANNER_RESPONSE") {
      if (source !== "MODEL") return;
      if (current?.role !== "assistant") {
        flush();
        current = {
          role: "assistant",
          blocks: [],
          recordIndex: index,
          unansweredCalls: [],
        };
      }
      if (typeof record.content === "string" && record.content.trim()) {
        current.blocks.push({ type: "text", text: record.content.trim() });
      }
      if (Array.isArray(record.tool_calls)) {
        record.tool_calls.forEach((call, i) => {
          const callObj = {
            type: "function_call",
            name: call.name,
            arguments: call.args ?? call.arguments,
            call_id: `${index}:${i}`,
          };
          current.blocks.push(callObj);
          current.unansweredCalls.push(callObj);
        });
      }
      return;
    }

    if (type === "GENERIC") {
      if (source !== "MODEL") return;
      if (current?.role !== "assistant") {
        flush();
        current = {
          role: "assistant",
          blocks: [],
          recordIndex: index,
          unansweredCalls: [],
        };
      }
      const matchedCall = current.unansweredCalls ? current.unansweredCalls.shift() : undefined;
      const name = matchedCall ? matchedCall.name : undefined;
      const call_id = matchedCall ? matchedCall.call_id : undefined;
      let output = record.content ?? "";
      let is_error = false;
      const status = String(record.status || "");
      if (status.toUpperCase() === "ERROR") {
        is_error = true;
        if (!output && record.error) {
          output = typeof record.error === "object" ? JSON.stringify(record.error) : String(record.error);
        }
      }
      const toolResult = {
        type: "tool_result",
        name,
        output,
        call_id,
        status: record.status,
        ...(is_error ? { is_error: true } : {}),
      };
      current.blocks.push(toolResult);
    }
  });

  flush();

  const turnPayloads = collected.map((turn) => ({ role: turn.role, content: turn.blocks }));

  const toolNameById = collectToolNamesByIdFromEntries(turnPayloads);

  const turns = [];
  for (const [index, payload] of turnPayloads.entries()) {
    if (payload.role === "assistant" && cfg.captureAssistantTurns === false) continue;
    const text = extractTextFromPayload(payload, { toolNameById }).trim();
    if (!text) continue;
    turns.push({
      role: normalizeCaptureRole(payload.role),
      content: cleanAntigravityText(text),
      turnId: String(collected[index].recordIndex),
    });
  }
  return turns;
}

/** Resolve transcript path from input payload. */
export function resolveAntigravityTranscriptPath(input = {}) {
  return String(input.transcriptPath || input.transcript_path || "").trim();
}

/** Extract unseen turns from the transcript file past lastTurnId. */
export function extractUnseenAntigravityTurns(transcriptPath, lastTurnId = null, cfg = {}) {
  if (!transcriptPath) return { status: "missing", turns: [] };
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch (error) {
    return { status: "unreadable", turns: [], error: error?.code || "read_failed" };
  }
  const turns = extractAntigravityTurns(parseTranscript(raw), cfg);
  if (turns.length === 0) return { status: "ok", turns: [] };
  let unseen = turns;
  if (lastTurnId != null && lastTurnId !== "") {
    const lastIndex = turns.findIndex((turn) => turn.turnId === String(lastTurnId));
    if (lastIndex !== -1) {
      unseen = turns.slice(lastIndex + 1);
    } else {
      const lastNum = Number(lastTurnId);
      if (!Number.isNaN(lastNum)) {
        unseen = turns.filter((turn) => Number(turn.turnId) > lastNum);
      }
    }
  }
  return { status: "ok", turns: unseen };
}

/** Build unseen turns from input and state. */
export function buildAntigravityTurns(input = {}, state = {}, cfg = {}) {
  return extractUnseenAntigravityTurns(
    resolveAntigravityTranscriptPath(input),
    state.lastTurnId || null,
    cfg,
  );
}

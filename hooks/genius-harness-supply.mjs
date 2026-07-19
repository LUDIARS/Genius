#!/usr/bin/env node
// UserPromptSubmit-compatible harness adapter around hooks/genius-supply.mjs.
//
// hooks/genius-supply.mjs is intentionally strict: it reads a raw UTF-8 prompt
// string from stdin and fails closed (stderr + exit 1) on any error. That contract
// is right for manual/CLI use (`'text' | node hooks/genius-supply.mjs`) and for
// tests, but it is not safe to point a Claude Code UserPromptSubmit hook at
// directly:
//
//   1. Claude Code delivers a JSON payload on stdin (`{ prompt, cwd, session_id,
//      ... }`), not a raw prompt string. Wiring genius-supply.mjs as-is would send
//      that whole JSON blob to Genius as the query text.
//   2. A hook wired into every session's prompt submission must never block a
//      prompt just because the optional local Genius service happens to be down
//      (the common case in most sessions/repos) -- it must fail OPEN, not closed.
//
// This adapter is that bridge: JSON-payload aware, bounded by a timeout, and fails
// open (silent exit 0) on any error so a missing/slow Genius service never affects
// prompt submission. It reuses the same query + formatting logic as
// genius-supply.mjs (no duplicated card-fetching logic).
//
// Wiring the actual `.claude/settings.json` UserPromptSubmit entry remains an
// Ars-side operational step (see README "Harness hook") -- this script is what
// that entry should invoke once wired.
//
// env:
//   GENIUS_HARNESS_HOOKS=1       opt-in switch. Unset/anything else -> no-op exit 0.
//   GENIUS_HARNESS_TIMEOUT_MS    query timeout budget in ms (default 2000).
//   GENIUS_HARNESS_DEBUG=1       diagnostics to stderr (never includes card content).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatGeniusSupply, readUtf8 } from "./genius-supply.mjs";
import { queryGeniusForHook } from "./genius-query-client.mjs";

const DEFAULT_TIMEOUT_MS = 2000;

function dbg(debug, ...args) {
  if (debug) process.stderr.write(`[genius-harness-supply] ${args.join(" ")}\n`);
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseTimeoutMs(value, debug) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    dbg(debug, `invalid GENIUS_HARNESS_TIMEOUT_MS=${value}, using default ${DEFAULT_TIMEOUT_MS}`);
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

function extractPrompt(raw) {
  const payload = JSON.parse(raw);
  if (payload === null || typeof payload !== "object") {
    throw new Error("hook payload must be a JSON object");
  }
  return typeof payload.prompt === "string" ? payload.prompt.trim() : "";
}

export async function runGeniusHarnessSupply(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const debug = env.GENIUS_HARNESS_DEBUG === "1";

  if (env.GENIUS_HARNESS_HOOKS !== "1") {
    dbg(debug, "disabled (GENIUS_HARNESS_HOOKS != 1)");
    return;
  }

  const timeoutMs = parseTimeoutMs(env.GENIUS_HARNESS_TIMEOUT_MS, debug);

  let raw;
  try {
    raw = await readUtf8(stdin);
  } catch (error) {
    dbg(debug, "stdin read failed, failing open:", messageOf(error));
    return;
  }

  let prompt;
  try {
    prompt = extractPrompt(raw);
  } catch (error) {
    dbg(debug, "payload parse failed, failing open:", messageOf(error));
    return;
  }
  if (!prompt) {
    dbg(debug, "empty prompt, nothing to supply");
    return;
  }

  try {
    const cards = await withTimeout(
      queryGeniusForHook(prompt, { env, fetchImplementation: options.fetchImplementation }),
      timeoutMs,
    );
    if (cards.length === 0) {
      dbg(debug, "no cards returned");
      return;
    }
    stdout.write(formatGeniusSupply(cards));
  } catch (error) {
    dbg(debug, "query failed, failing open:", messageOf(error));
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isEntrypoint() {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isEntrypoint()) {
  try {
    await runGeniusHarnessSupply();
  } catch (error) {
    // A harness supply hook must never throw into the caller's prompt submission.
    process.stderr.write(`genius-harness-supply unexpected error (failing open): ${messageOf(error)}\n`);
  }
  process.exitCode = 0;
}
/**
 * Assembled runtime index for the Antigravity plugin bundle.
 * Purpose: Replaces hosts/index.mjs during installation assembly to bundle only the antigravity host.
 * Usage: Loaded by hook.mjs and uri-guard.mjs inside the assembled bundle.
 */
import { antigravity } from "./antigravity.mjs";

export const HOSTS = { antigravity };

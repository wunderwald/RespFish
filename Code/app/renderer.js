/**
 * renderer.js — orchestrator
 * ==========================
 * Wires the stream infrastructure to the active frontend.
 * To swap the frontend, replace the Visualizer import with another module
 * that implements the same interface:
 *   pushSample(value: number) → void
 *   setStatus({ type, text })  → void
 */

import { StreamManager } from "./modules/stream.js";
import { Visualizer }    from "./modules/visualizer.js";

// ── mount points (defined in index.html) ─────────────────────────────────────
const streamContainer = document.getElementById("stream-bar");
const statsContainer  = document.getElementById("stats");
const sceneContainer  = document.getElementById("scene");

// ── instantiate modules ───────────────────────────────────────────────────────
const stream   = new StreamManager({ container: streamContainer });
const frontend = new Visualizer({ statsContainer, sceneContainer });

// ── wire stream events → frontend ─────────────────────────────────────────────
stream.on("sample", ({ value }) => frontend.pushSample(value));
stream.on("status", (event)     => frontend.setStatus(event));

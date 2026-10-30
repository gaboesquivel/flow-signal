#!/usr/bin/env node
// UserPromptSubmit hook: append each prompt to prompts.txt with the real UTC time (spec 010).
// The agent adds the `Response:` line. Never blocks a prompt: always exits 0 and prints nothing.
import { appendFileSync } from "node:fs";
import path from "node:path";

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const prompt = String(input.prompt ?? "")
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, 500);
    if (!prompt) return;
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
    appendFileSync(path.join(root, "prompts.txt"), `\n[${stamp}]\nPrompt: ${prompt}\n`);
  } catch {
    // Logging must never get in the way of the prompt.
  }
});

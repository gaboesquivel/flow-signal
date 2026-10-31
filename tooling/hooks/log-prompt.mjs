#!/usr/bin/env node
// UserPromptSubmit hook: append each user prompt, redacted, to this session's own Git-ignored
// `.sessions/<tag>.prompts.log` in the main checkout. Harness turns (subagent hand-backs, task
// notifications, events) are skipped. Never blocks a prompt: always exits 0; its only output
// tells the agent where the log is and how to add its response line.
import { logPrompt } from "./prompt-log.mjs";

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const logged = logPrompt(JSON.parse(raw || "{}"));
    if (!logged) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `Prompt logged for session:${logged.session} (Git-ignored, redacted). After responding, run \`node tooling/hooks/log-response.mjs ${logged.session} "<brief summary>"\`.`,
          hookEventName: "UserPromptSubmit",
        },
      }),
    );
  } catch {
    // Logging must never get in the way of the prompt.
  }
});

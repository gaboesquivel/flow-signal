#!/usr/bin/env node
// UserPromptSubmit hook: append each user prompt to prompts.txt with the real UTC time and a
// short session tag (spec 010). Harness turns (subagent hand-backs, task notifications, events)
// are skipped. The agent appends the matching `Response [<session>]:` line. Never blocks a
// prompt: always exits 0; its only output is the session tag, added to the agent's context.
import { logPrompt } from "./prompt-log.mjs";

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const session = logPrompt(JSON.parse(raw || "{}"));
    if (!session) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `prompts.txt logged this prompt as session:${session}; append your summary as one line \`Response [${session}]: ...\`.`,
          hookEventName: "UserPromptSubmit",
        },
      }),
    );
  } catch {
    // Logging must never get in the way of the prompt.
  }
});

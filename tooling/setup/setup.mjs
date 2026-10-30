import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyDataPreset, readDatabaseUrl, upsertEnvLine } from "./data-preset.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const envExample = path.join(root, ".env.example");
const envLocal = path.join(root, ".env.local");

if (!existsSync(envLocal) && existsSync(envExample)) copyFileSync(envExample, envLocal);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) {
  console.error("Node.js 24+ is required.");
  process.exit(1);
}

try {
  execSync("pnpm -v", { stdio: "ignore" });
} catch {
  console.error("pnpm is required. Enable via corepack.");
  process.exit(1);
}

if (!existsSync(path.join(root, "node_modules")))
  execSync("pnpm install", { cwd: root, stdio: "inherit" });

// Skills are committed under .agents/skills; restore them from skills-lock.json only when missing.
if (!existsSync(path.join(root, ".agents/skills")))
  execSync("pnpm skills:install", { cwd: root, stdio: "inherit" });

const envFile = path.join(root, ".env.local");
const envText = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";
const linkFile = path.join(root, ".vercel/project.json");
const link = existsSync(linkFile) ? JSON.parse(readFileSync(linkFile, "utf-8")) : {};
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const preset = await applyDataPreset({
  env: process.env,
  local: {
    databaseUrl: readDatabaseUrl(envText),
    vercelOrgId: link.orgId,
    vercelProjectId: link.projectId,
  },
  preset: process.env.FLOW_PRESET ?? "minimal",
  projectName: pkg.name,
});
if (!preset.ok) {
  console.error(preset.error);
  process.exit(1);
}
if (preset.databaseUrl) {
  const next = upsertEnvLine({
    key: "DATABASE_URL",
    text: existsSync(envFile) ? readFileSync(envFile, "utf-8") : envText,
    value: preset.databaseUrl,
  });
  if (next.changed) writeFileSync(envFile, next.text);
}
if (preset.vercel) {
  mkdirSync(path.dirname(linkFile), { recursive: true });
  writeFileSync(
    linkFile,
    `${JSON.stringify({ orgId: preset.vercel.orgId, projectId: preset.vercel.projectId }, null, 2)}\n`,
  );
}
if (preset.preset === "neon")
  console.log(preset.reused ? "neon preset reused" : "neon preset configured");

console.log("setup complete — review .env.local before running pnpm dev");

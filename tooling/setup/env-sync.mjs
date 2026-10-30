// `pnpm env:sync` (also run by `pnpm db:dev`): adds the keys in .env.example's local defaults
// section to .env.local when .env.local does not mention them, so a flag that is on for local
// development reaches every checkout. Never overwrites or removes a line: a key that is present,
// empty, or commented out in .env.local is left alone. Prints key names only, never values.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LOCAL_DEFAULTS_BEGIN = "# >>> local defaults";
export const LOCAL_DEFAULTS_END = "# <<< local defaults";

const keyOf = (line) =>
  /^\s*(?:#\s*)?(?:export\s+)?(?<key>[A-Z][A-Z0-9_]*)\s*=/u.exec(line)?.groups?.key;

/** `KEY=value` lines between the local defaults markers of an env example. */
export const readLocalDefaults = (exampleText) => {
  const lines = String(exampleText ?? "").split("\n");
  const begin = lines.findIndex((line) => line.startsWith(LOCAL_DEFAULTS_BEGIN));
  if (begin === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > begin && line.startsWith(LOCAL_DEFAULTS_END),
  );
  return lines
    .slice(begin + 1, end === -1 ? undefined : end)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => ({ key: keyOf(line), line }));
};

/** The local env text with missing local defaults appended, and the keys that were added. */
export const syncLocalDefaults = ({ exampleText, localText }) => {
  const present = new Set(
    String(localText ?? "")
      .split("\n")
      .map(keyOf)
      .filter(Boolean),
  );
  const missing = readLocalDefaults(exampleText).filter(({ key }) => !present.has(key));
  if (missing.length === 0) return { added: [], text: String(localText ?? "") };
  const base = String(localText ?? "");
  const separator = base === "" || base.endsWith("\n") ? "" : "\n";
  const block = [
    "",
    "# Local defaults added by `pnpm env:sync` from .env.example",
    ...missing.map(({ line }) => line),
    "",
  ].join("\n");
  return { added: missing.map(({ key }) => key), text: `${base}${separator}${block}` };
};

const main = () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const examplePath = path.join(root, ".env.example");
  const localPath = path.join(root, ".env.local");
  if (!existsSync(examplePath)) return;
  const localText = existsSync(localPath) ? readFileSync(localPath, "utf-8") : "";
  const { added, text } = syncLocalDefaults({
    exampleText: readFileSync(examplePath, "utf-8"),
    localText,
  });
  if (added.length === 0) {
    console.log("[env:sync] .env.local has every local default.");
    return;
  }
  writeFileSync(localPath, text);
  console.log(`[env:sync] added to .env.local: ${added.join(", ")}`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

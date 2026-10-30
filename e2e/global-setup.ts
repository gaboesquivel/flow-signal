import { execFileSync } from "node:child_process";

/** Reseeds the local e2e database before the run (see e2e/seed-console.ts). */
export default function globalSetup() {
  execFileSync(process.execPath, ["--import", "tsx", "e2e/seed-console.ts"], {
    env: process.env,
    stdio: "inherit",
  });
}

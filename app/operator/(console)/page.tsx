import { redirect } from "next/navigation";

/** The console opens on Triage. (The GenUI studio that used to live here is also at /genui.) */
export default function OperatorPage() {
  redirect("/operator/triage");
}

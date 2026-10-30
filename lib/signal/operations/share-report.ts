import { z } from "zod";

import { publicTextFindingSchema } from "../domain/public-text";
import { reportDepsFor, shareReport as share } from "../domain/reports";
import { defineOperation } from "./types";

export const shareReport = defineOperation({
  access: "operator",
  description:
    'Share a saved report as a read-only link anyone with the URL can open, refresh what the link shows, or revoke it. `action: "share"` or `"refresh"` re-runs the report\'s queries into a snapshot and checks its titles, text, labels, and table cells for customer names, account names, and emails. If anything is found and `acknowledgeFlags` is not true, nothing changes and you get `{ status: "needs_acknowledgement", flags }` (`kind`: person, account, or email; `match`): show the flags to the PM and call again with `acknowledgeFlags: true` only after they confirm. Otherwise `{ status: "shared", path: "/r/<token>", snapshotAt }`; an existing link keeps its token and now shows the new snapshot. `action: "revoke"` disables the link (`{ status: "revoked" }`); it then returns not found. Unknown `reportId`: `not_found`.',
  effects: "write",
  errors: ["not_found"],
  http: { method: "POST", path: "/api/operator/reports/:reportId/share" },
  input: z.object({
    acknowledgeFlags: z.boolean().optional(),
    action: z.enum(["share", "refresh", "revoke"]),
    reportId: z.uuid(),
  }),
  name: "share_report",
  output: z.discriminatedUnion("status", [
    z.object({
      flags: z.array(publicTextFindingSchema),
      status: z.literal("needs_acknowledgement"),
    }),
    z.object({
      path: z.string(),
      snapshotAt: z.iso.datetime({ offset: true }),
      status: z.literal("shared"),
    }),
    z.object({ status: z.literal("revoked") }),
  ]),
  run(input, ctx) {
    return share(reportDepsFor(ctx), input);
  },
});

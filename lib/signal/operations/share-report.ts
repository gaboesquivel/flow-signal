import { z } from "zod";

import { publicTextFindingSchema } from "../domain/public-text";
import { previewShareReport, reportDepsFor, shareReport as share } from "../domain/reports";
import { defineOperation } from "./types";

/** What the preview says happens to the link, by action and whether one is live now. */
const linkEffect = {
  refresh: { live: "refreshed (same link)", none: "created" },
  revoke: { live: "disabled", none: "none to disable" },
  share: { live: "refreshed (same link)", none: "created" },
} as const;

const previewTitle = {
  refresh: "Refresh a report link",
  revoke: "Revoke a report link",
  share: "Share a report link",
} as const;

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
  async preview({ action, reportId }, ctx) {
    const { flags, link, title } = await previewShareReport(reportDepsFor(ctx), {
      action,
      reportId,
    });
    const linkLine = linkEffect[action][link ? "live" : "none"];
    return {
      blocks: [],
      editable: [],
      lines: [
        { label: "Report", value: title },
        { label: "Link", value: linkLine },
        ...(action === "revoke"
          ? []
          : [{ label: "Identifying text flagged", value: String(flags.length) }]),
      ],
      needs: [],
      notes:
        flags.length === 0
          ? []
          : [
              ...flags.map((flag) => `Shows ${flag.kind}: ${flag.match}`),
              "Confirming shares it anyway and acknowledges these.",
            ],
      title: previewTitle[action],
    };
  },
  run(input, ctx) {
    return share(reportDepsFor(ctx), input);
  },
});

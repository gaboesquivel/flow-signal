import { z } from "zod";

import { datasetResultSchema } from "../domain/report-datasets";
import { reportSpecSchema } from "../domain/report-spec";
import { getSharedReport as getShared, shareTokenSchema } from "../domain/reports";
import { defineOperation } from "./types";

export const getSharedReport = defineOperation({
  access: "public",
  description:
    "Read a report a product manager shared as a read-only link, by its `token` (the last path segment of a `/r/<token>` URL someone gave you). Returns `{ title, spec, data, snapshotAt }`: the report as of `snapshotAt`, not live data; `data` holds each dataset's columns and rows keyed by dataset id (money in cents). An unknown or revoked token is `not_found`.",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/shared-reports/:token" },
  input: z.object({ token: shareTokenSchema }),
  name: "get_shared_report",
  output: z.object({
    data: z.record(z.string(), datasetResultSchema),
    snapshotAt: z.iso.datetime({ offset: true }),
    spec: reportSpecSchema,
    title: z.string(),
  }),
  run({ token }, { actor, clock, db }) {
    return getShared({ actor, db, now: clock.now() }, token);
  },
});

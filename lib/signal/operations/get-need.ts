import { z } from "zod";

import { getPublicNeed, publicNeedSchema } from "../domain/public-needs";
import { SignalError } from "../errors";
import { defineOperation } from "./types";

export const getNeed = defineOperation({
  access: "public",
  description:
    "Read one public need by id: statement, status, theme, proposed solutions, supporter count, demand band, approved use-case summary, and decision note. A merged need reports `status: merged` and `mergedIntoId`.",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/needs/:id" },
  input: z.object({ id: z.uuid() }),
  name: "get_need",
  output: publicNeedSchema,
  async run({ id }, { db }) {
    const need = await getPublicNeed(db, id);
    if (!need) throw new SignalError("not_found", `No need with id ${id}.`);
    return need;
  },
});

import { z } from "zod";

import { getNeedDetail as readNeedDetail, needDetailSchema } from "../domain/need-detail";
import { SignalError } from "../errors";
import { defineOperation } from "./types";

export const getNeedDetail = defineOperation({
  access: "operator",
  description:
    "Read the full PM view of one need by id: statement, status, theme, public summary and its approval status, proposed solutions, every verbatim signal with its submitter and account, the accounts behind it with ARR and open deals, priority scores with reasons, the weighted priority score, decisions, merges in and out, and every AI suggestion about it. Operator only: contains private data.",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/operator/needs/:id" },
  input: z.object({ id: z.uuid() }),
  name: "get_need_detail",
  output: needDetailSchema,
  async run({ id }, { db }) {
    const detail = await readNeedDetail(db, id);
    if (!detail) throw new SignalError("not_found", `No need with id ${id}.`);
    return detail;
  },
});

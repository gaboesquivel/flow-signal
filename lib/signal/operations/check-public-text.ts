import { z } from "zod";

import {
  checkPublicText as checkPublicTextInDb,
  MAX_PUBLIC_TEXT_LENGTH,
  publicTextFindingSchema,
} from "../domain/public-text";
import { defineOperation } from "./types";

export const checkPublicText = defineOperation({
  access: "operator",
  description:
    'Check text you are about to make public (a public summary or a decision note) for customer names, account names, and emails from the workspace. With `needId`, checks against the people and accounts behind that need; without, against the whole workspace. Deterministic, no model: case-insensitive, whole words for names, an account also without its legal suffix ("Acme Corp" → "Acme"), people by full name. Returns `findings` (`kind`: person, account, or email; `match`: the text as written), empty when nothing identifying was found. Edit the text until it has no findings before publishing.',
  errors: ["not_found"],
  http: { method: "POST", path: "/api/operator/check-public-text" },
  input: z.object({
    needId: z.uuid().optional(),
    text: z.string().max(MAX_PUBLIC_TEXT_LENGTH),
  }),
  // Room for 10,000 characters of multibyte text in the JSON body.
  limits: { maxBodyBytes: 64 * 1024 },
  name: "check_public_text",
  output: z.object({ findings: z.array(publicTextFindingSchema) }),
  run(input, { db }) {
    return checkPublicTextInDb(db, input);
  },
});

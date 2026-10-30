import { asc } from "drizzle-orm";
import { z } from "zod";

import { themes } from "@/lib/db/schema";

import { defineOperation } from "./types";

const themeSchema = z.object({
  description: z.string(),
  id: z.uuid(),
  name: z.string(),
  strategicWeight: z.number(),
});

export const listThemes = defineOperation({
  access: "operator",
  description:
    "List every theme in the workspace, by name: its id, name, description, and strategic weight (0–1, used by priority scoring). Use the ids as `focusThemeIds` in set_strategy; themes with no live need are listed too.",
  errors: [],
  http: { method: "GET", path: "/api/operator/themes" },
  input: z.object({}),
  name: "list_themes",
  output: z.object({ themes: z.array(themeSchema) }),
  async run(_input, { db }) {
    const rows = await db
      .select({
        description: themes.description,
        id: themes.id,
        name: themes.name,
        strategicWeight: themes.strategicWeight,
      })
      .from(themes)
      .orderBy(asc(themes.name));
    return { themes: rows };
  },
});

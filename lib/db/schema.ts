import { integer, pgTable } from "drizzle-orm/pg-core";

export const health = pgTable("health", {
  ok: integer("ok").notNull(),
});

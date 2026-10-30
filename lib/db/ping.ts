import { health } from "@/lib/db/schema";

const defaultQuery = async (databaseUrl: string) => {
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  const db = drizzle(neon(databaseUrl));
  return db.select().from(health).limit(1);
};

export const pingDatabase = async ({
  databaseUrl,
  query = defaultQuery,
}: {
  databaseUrl?: string;
  query?: (databaseUrl: string) => Promise<unknown> | unknown;
}) => {
  if (!databaseUrl?.trim()) return { ok: false as const, status: 503 as const };
  await query(databaseUrl);
  return { ok: true as const };
};

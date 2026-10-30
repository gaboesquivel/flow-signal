import { pingDatabase } from "@/lib/db/ping";

export const dynamic = "force-dynamic";

export const GET = async () => {
  const result = await pingDatabase({ databaseUrl: process.env.DATABASE_URL });
  if (!result.ok)
    return Response.json({ error: "database is not configured" }, { status: result.status });
  return Response.json({ ok: true });
};

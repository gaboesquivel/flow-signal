/** Opaque offset cursors: base64url JSON of the next offset (same format as `search_needs`). */
export const encodeOffsetCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString("base64url");

export const decodeOffsetCursor = (cursor: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    parsed = null;
  }
  const offset = (parsed as { o?: unknown } | null)?.o;
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
};

/**
 * A `report_compose` fake answers as the model does: each block as `{ kind, json }`, the
 * block's other fields JSON-encoded (spec 013). Tests write plain blocks and wrap them here.
 */
export const toModelCompose = (output: unknown) => {
  const { blocks, ...rest } = output as { blocks: Record<string, unknown>[] };
  return {
    ...rest,
    blocks: blocks.map(({ kind, ...fields }) => ({ json: JSON.stringify(fields), kind })),
  };
};

export const asModelCompose =
  <I>(handler: ((input: I) => unknown) | undefined) =>
  (input: I) =>
    handler ? toModelCompose(handler(input)) : null;

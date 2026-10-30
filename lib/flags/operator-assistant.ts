/**
 * The experimental Operator assistant (spec 014): `OPERATOR_ASSISTANT=on` turns `/operator/chat`
 * into the assistant and enables `/api/operator/assistant*`. Read on the server only.
 */
export const isOperatorAssistantEnabled = () =>
  process.env.OPERATOR_ASSISTANT?.trim().toLowerCase() === "on";

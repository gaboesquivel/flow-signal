const allowedEnvNames = new Set([".env.example", ".env.schema"]);

const blockedSuffixes = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".crt",
  ".cer",
  ".der",
  ".p7b",
  ".p7c",
  ".p7m",
  ".p7s",
  ".keytab",
];

const basenameOf = (filename) => filename.split("/").pop() ?? filename;

export const isAllowedEnvTemplate = (filename) => {
  const name = basenameOf(filename);
  if (allowedEnvNames.has(name)) return true;
  return /^\.env\.[^/]+\.example$/u.test(name);
};

const isEnvLike = (name) =>
  name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name.includes(".env.");

const isKeyMaterial = (name) =>
  name === "id_rsa" ||
  name.startsWith("id_rsa.") ||
  blockedSuffixes.some((suffix) => name.endsWith(suffix));

export function isBlocked(filename) {
  const name = basenameOf(filename);
  if (isAllowedEnvTemplate(filename)) return false;
  return isEnvLike(name) || isKeyMaterial(name);
}

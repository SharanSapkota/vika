// Checks on DATABASE_URL that don't need a connection: is it a URL at all,
// and is it set up in a way known to cause trouble. Never echoes the URL,
// since it holds a password.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Query parameters that can carry a secret.
const SECRET_PARAMETERS = new Set(["password", "sslpassword", "sslkey"]);
const MASK = "****";

export function parseDatabaseUrl(databaseUrl: string): URL | undefined {
  try {
    return new URL(databaseUrl);
  } catch {
    return undefined;
  }
}

// Advice, not errors: vika still runs, but the operator should know.
export function findDatabaseUrlWarnings(databaseUrl: URL): string[] {
  const warnings: string[] = [];
  const hostname = databaseUrl.hostname.toLowerCase();
  if (hostname.includes("-pooler")) {
    warnings.push(
      'DATABASE_URL points at a connection pooler ("-pooler" in the host). Advisory locks can break through a pooler; use the direct connection string.',
    );
  }
  // An empty host means a local Unix socket.
  const isLocal = hostname === "" || LOCAL_HOSTS.has(hostname);
  if (!isLocal && !databaseUrl.searchParams.has("sslmode")) {
    warnings.push("DATABASE_URL is not on localhost and has no sslmode. Add ?sslmode=require so the connection is encrypted.");
  }
  return warnings;
}

// The URL with its password (and any secret query parameter) replaced by "****".
export function maskDatabaseUrl(databaseUrl: string): string {
  const parsedUrl = parseDatabaseUrl(databaseUrl);
  if (parsedUrl === undefined) return "(hidden: not a valid URL)";
  if (parsedUrl.password !== "") parsedUrl.password = MASK;
  for (const parameterName of [...parsedUrl.searchParams.keys()]) {
    if (SECRET_PARAMETERS.has(parameterName.toLowerCase())) parsedUrl.searchParams.set(parameterName, MASK);
  }
  return parsedUrl.toString();
}

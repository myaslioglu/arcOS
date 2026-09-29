import { DataError } from "../errors";
import { DATABASE_ENV, DATABASE_ID } from "../names";

// Firestore's rule for a database id: 4 to 63 characters, lowercase letters, digits and hyphens, starting with a letter
// and ending with a letter or digit. "(default)" is not one.
const NAMED_DATABASE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

/**
 * The database to open: ARCOS_FIRESTORE_DATABASE when it is set (tests), otherwise arcos. A blank value counts as unset,
 * and "(default)" is refused along with everything else that is not a named database: this package never addresses
 * (default). It reads no Admin SDK, so a unit test can call it.
 */
export function resolveDatabaseId(env: Readonly<Record<string, string | undefined>>): string {
  const requested = env[DATABASE_ENV]?.trim();
  const id = requested ? requested : DATABASE_ID;
  if (!NAMED_DATABASE.test(id)) {
    throw new DataError(
      "database-id",
      `${DATABASE_ENV} must name a Firestore database: 4 to 63 lowercase letters, digits or hyphens, and not (default)`,
    );
  }
  return id;
}

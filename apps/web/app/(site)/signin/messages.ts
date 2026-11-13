/** The `?error=` value `signInDemo` sets when `authorizeDemo` returned null (demo supplier missing). */
export const DEMO_NOT_SEEDED_ERROR = "demo";
/** The `?error=` value `signInDemo` sets for any other Auth.js failure. */
export const SIGN_IN_FAILED_ERROR = "failed";
/** The `?error=` value the Graveyard page sets when the session's supplier no longer exists (demo reset). */
export const SESSION_EXPIRED_ERROR = "SessionExpired";
const DEMO_NOT_SEEDED_MESSAGE = "Demo data is not seeded";
const SESSION_EXPIRED_MESSAGE = "The demo was reset. Enter the graveyard again.";
const GENERIC_MESSAGE = "Sign-in failed. Please try again.";
/**
 * The text for a `?error=` query value, or null when there is no error.
 * The exact "demo" flag gets the not-seeded message and the exact "SessionExpired" flag gets the
 * reset message; every other value, including ones this app never sets (such as Auth.js's own
 * `CredentialsSignin`), gets the generic message.
 */
export function signInErrorMessage(error: string | string[] | undefined): string | null {
  const value = Array.isArray(error) ? error[0] : error;
  if (value === undefined || value === "") return null;
  if (value === DEMO_NOT_SEEDED_ERROR) return DEMO_NOT_SEEDED_MESSAGE;
  if (value === SESSION_EXPIRED_ERROR) return SESSION_EXPIRED_MESSAGE;
  return GENERIC_MESSAGE;
}

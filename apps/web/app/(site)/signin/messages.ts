/** The `?error=` value `signInDemo` sets when `authorizeDemo` returned null (demo supplier missing). */
export const DEMO_NOT_SEEDED_ERROR = "demo";
/** The `?error=` value `signInDemo` sets for any other Auth.js failure. */
export const SIGN_IN_FAILED_ERROR = "failed";
const DEMO_NOT_SEEDED_MESSAGE = "Demo data is not seeded";
const GENERIC_MESSAGE = "Sign-in failed. Please try again.";
/**
 * The text for a `?error=` query value, or null when there is no error.
 * Only the exact "demo" flag gets the not-seeded message; every other value, including ones this
 * app never sets (such as Auth.js's own `CredentialsSignin`), gets the generic message.
 */
export function signInErrorMessage(error: string | string[] | undefined): string | null {
  const value = Array.isArray(error) ? error[0] : error;
  if (value === undefined || value === "") return null;
  return value === DEMO_NOT_SEEDED_ERROR ? DEMO_NOT_SEEDED_MESSAGE : GENERIC_MESSAGE;
}

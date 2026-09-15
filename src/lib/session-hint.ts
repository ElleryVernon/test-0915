/** Name of the readable flag the server sets next to the HttpOnly session cookie. */
export const SESSION_HINT = 'memoryz_signed_in';

/**
 * Whether the browser holds the signed-in flag. The flag is not an authorization of any kind: it
 * only tells the app that asking the server for bootstrap can succeed, so a logged-out device
 * shows the sign-in screen without first collecting a 401.
 */
export function sessionHint(cookie: string): boolean {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .some((part) => part === `${SESSION_HINT}=1`);
}

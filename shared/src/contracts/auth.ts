// -----------------------------------------------------------------------------
// Auth wire types — shared by the backend (auth routes) and the frontend
// (AuthBoot, lib/auth.ts). All fields are wire-safe primitives.
// -----------------------------------------------------------------------------

export interface AuthUser {
  /** uuidv7 — same uuid that scopes positions/orders/alerts. */
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  /** True for the seeded demo user; false for real Google sign-ins. */
  isDemo: boolean;
}

/** Body of GET /api/auth/me on success. */
export interface AuthMeResponse {
  user: AuthUser;
}

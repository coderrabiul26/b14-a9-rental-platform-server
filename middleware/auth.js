import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * JWT verification for the Express API.
 *
 * The Next.js app (Better Auth, `jwt()` plugin) signs an EdDSA JWT access
 * token on login / registration and publishes its PUBLIC keys as a JWKS at
 * `/.well-known/jwks.json`. This module fetches and caches that JWKS, then
 * verifies incoming `Authorization: Bearer <token>` headers against it.
 *
 * No shared secret is needed — verification uses the public key only.
 */

// Where the Next.js app (Better Auth) publishes its public JWKS.
// Better Auth mounts the JWT plugin's `getJwks` endpoint under its base
// path (`/api/auth`), so the default is `/api/auth/jwks`.

// The JWT plugin sets `aud` / `iss` from its options; we left them default,
// so we verify the signature + expiry and trust the payload.
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_BASE_URL}/api/auth/jwks`));

/**
 * Verifies a Bearer token and returns its payload, or `null` if the token is
 * missing, malformed, expired, or the signature is invalid.
 *
 * @param token - the raw JWT string (without the "Bearer " prefix)
 * @returns the decoded payload ({ sub, role, email, ... }) or null
 */
export async function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const { payload } = await jwtVerify(token, JWKS);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware: requires a valid Bearer token.
 * Attaches `req.user = { id, role, email, ... }` on success.
 * Responds 401 with `{ message }` on failure.
 */
export async function verifyTokenMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ message: "Unauthorized: missing or malformed token" });
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }

  req.user = {
    id: payload.sub,
    role: payload.role,
    email: payload.email,
  };
  next();
}

/**
 * Role guard factory. Pass the role(s) that are allowed through.
 * Responds 403 with `{ message }` when the user's role is not permitted.
 *
 * @example
 *   app.post("/api/addEquipment", verifyTokenMiddleware, verifyRole("owner"), handler)
 */
export function verifyRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        message: `Forbidden: requires role ${allowedRoles.join(" or ")}`,
      });
    }
    next();
  };
}

// Convenience, named exports requested by the assignment brief.
export const verifyRenter = verifyRole("customer");
export const verifyOwner = verifyRole("owner");
export const verifyAdmin = verifyRole("admin");

export default {
  verifyToken: verifyTokenMiddleware,
  verifyRole,
  verifyRenter,
  verifyOwner,
  verifyAdmin,
};
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class GoogleTokenError extends Error {}

async function refreshGoogleToken(refreshToken: string): Promise<string> {
    const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID || "",
            client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
        throw new GoogleTokenError(`Google token refresh failed (${r.status}): ${d.error || ""}`);
    }
    const fresh = d.id_token || d.access_token;
    if (!fresh) throw new GoogleTokenError("Google token refresh returned no token");
    return fresh;
}

/**
 * Builds the zero-arg "token provider" that pw_access accepts wherever a
 * googleToken is expected. Returns the JWT's stored Google token while it is
 * still valid, then exchanges the stored refresh token for a fresh one — so
 * pw_access can mint a new 7-day session pass at any point in the session,
 * including on cold serverless instances hours after sign-in.
 *
 * Throws GoogleTokenError when no valid token can be produced (no refresh
 * token stored and the sign-in token has expired) — callers should respond
 * 401 so the user re-signs in.
 */
export function createGoogleTokenProvider(jwt: {
    googleToken?: string;
    googleTokenExpiry?: number;
    googleRefreshToken?: string;
}) {
    let cached = {
        token: jwt.googleToken || "",
        expiry: Number(jwt.googleTokenExpiry) || 0,
    };
    const refreshToken = jwt.googleRefreshToken || "";
    return async function googleToken(): Promise<string> {
        if (cached.token && Date.now() < cached.expiry - REFRESH_BUFFER_MS) {
            return cached.token;
        }
        if (!refreshToken) {
            // JWT minted before offline access was enabled: the stored token
            // may still be inside its first hour, so let it through; once it
            // dies the proxy rejects it and the user re-signs in (which
            // stores a refresh token and fixes this permanently).
            if (cached.token) return cached.token;
            throw new GoogleTokenError("No Google token available; please sign in again.");
        }
        cached = {
            token: await refreshGoogleToken(refreshToken),
            expiry: Date.now() + 55 * 60 * 1000,
        };
        return cached.token;
    };
}

import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { checkAllowed } from "@/pw_access.js";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.");
}

export const authOptions: NextAuthOptions = {
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
            // Offline access issues a refresh token, so API routes can mint a
            // fresh Google token after the ~1-hour id_token expires (the
            // session itself lasts 7 days). "consent" is required or Google
            // only returns the refresh token on the very first authorization.
            authorization: {
                params: { access_type: "offline", prompt: "consent" },
            },
        }),
    ],
    callbacks: {
        async signIn({ user, account }) {
            const email = user.email?.toLowerCase();
            if (!email || !email.endsWith("@pw.live")) return false;

            const googleToken = account?.id_token || account?.access_token;
            if (!googleToken) {
                console.error(`No Google token available for ${email}; denying access.`);
                return false;
            }

            if (await checkAllowed(googleToken)) return true;
            console.log(`Rejected login from unauthorized email: ${email}`);
            return false;
        },
        async jwt({ token, account }) {
            if (account) {
                (token as any).googleToken = account.id_token || account.access_token || "";
                (token as any).googleTokenExpiry = account.expires_at
                    ? account.expires_at * 1000
                    : Date.now() + 3600 * 1000;
                (token as any).googleRefreshToken =
                    account.refresh_token || (token as any).googleRefreshToken || "";
            }
            return token;
        },
        async session({ session }) {
            const email = session.user?.email?.toLowerCase();
            if (email && !email.endsWith("@pw.live")) {
                session.user = undefined as any;
                (session as any).error = "Invalid email domain";
                return session;
            }
            return session;
        },
    },
    session: {
        strategy: "jwt",
        maxAge: SESSION_MAX_AGE_SECONDS,
        updateAge: 24 * 60 * 60,
    },
    jwt: {
        maxAge: SESSION_MAX_AGE_SECONDS,
    },
    pages: {}
};

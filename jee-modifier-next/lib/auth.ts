import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.");
}

if (!process.env.SHEETS_WEBAPP_URL) {
    console.warn("Missing SHEETS_WEBAPP_URL — sign-in will reject every user until this is set.");
}

export const authOptions: NextAuthOptions = {
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        }),
    ],
    callbacks: {
        async signIn({ user }) {
            if (!user.email) return false;

            const scriptUrl = process.env.SHEETS_WEBAPP_URL;
            if (!scriptUrl) {
                console.error("SHEETS_WEBAPP_URL not configured — denying access");
                return false;
            }

            try {
                const res = await fetch(
                    `${scriptUrl}?email=${encodeURIComponent(user.email)}`,
                    { cache: "no-store" }
                );
                if (!res.ok) {
                    console.error(`Whitelist check failed for ${user.email}: HTTP ${res.status}`);
                    return false;
                }
                const data = await res.json();
                if (data.allowed === true) return true;
                console.log(`Rejected login from unauthorized email: ${user.email}`);
                return false;
            } catch (err) {
                console.error(`Whitelist check error for ${user.email}:`, err);
                return false;
            }
        },
        async session({ session, token }) {
            return session;
        }
    },
    session: {
        strategy: "jwt",
    },
    pages: {}
};

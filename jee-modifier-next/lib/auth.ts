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

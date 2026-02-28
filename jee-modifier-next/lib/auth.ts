<<<<<<< HEAD:app/api/auth/[...nextauth]/route.ts
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
=======
import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// Ensure required environment variables are present (fail fast in production)
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
        async signIn({ user }) {
            // 1. Check if the user has an email
            if (!user.email) return false;

            // 2. Load the allowlist from environment variables
            const allowedEmailsRaw = process.env.ALLOWED_EMAILS || "";
            const allowedEmails = allowedEmailsRaw.split(",").map(e => e.trim().toLowerCase());

            // 3. Grant access ONLY if their email is in the allowlist
            if (allowedEmails.includes(user.email.toLowerCase())) {
                return true;
            }

            // Reject login
            console.log(`Rejected login attempt from unauthorized email: ${user.email}`);
            return false;
        },
        async session({ session, token }) {
            return session;
        }
    },
    session: {
        strategy: "jwt",
    },
    pages: {
        // You can customize the sign in page route here if wanted
        // signIn: '/auth/signin', 
    }
};
>>>>>>> 78daad3b5c1f72d1b24e469c8e2770f17a72b172:jee-modifier-next/lib/auth.ts

import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import SessionProviderContext from '@/components/SessionProviderContext';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
    title: 'JEE Modifier - AI Paper Generator',
    description: 'Multi-Paper Variant Generator powered by Gemini',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body className={inter.className}>
                <SessionProviderContext>
                    {children}
                </SessionProviderContext>
            </body>
        </html>
    );
}

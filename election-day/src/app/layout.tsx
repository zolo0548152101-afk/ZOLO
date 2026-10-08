import type { Metadata } from "next";
import { Assistant, Heebo } from "next/font/google";
import "./globals.css";

const display = Assistant({
  subsets: ["hebrew", "latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
});

const body = Heebo({
  subsets: ["hebrew", "latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ניהול יום בחירות | אשכולות",
  description: "סינון ומיון אשכולות קלפי לפי אחוז הצבעה ואחוז ימין",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}

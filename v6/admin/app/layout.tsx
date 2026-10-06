import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "חיים יחד · ניהול",
  description: "מסך ניהול לחיים יחד גרסה 6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}

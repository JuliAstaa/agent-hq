import type { Metadata } from "next";
import { Bungee, Fredoka, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Same families as the prototype's Google Fonts link (Bungee; Fredoka 400-700; JetBrains Mono 400, 600).
// The engine reads these CSS variables to get the real (hashed) family names for canvas text.
const bungee = Bungee({ weight: "400", subsets: ["latin"], variable: "--font-bungee", display: "swap" });
const fredoka = Fredoka({ subsets: ["latin"], variable: "--font-fredoka", display: "swap" });
const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agent HQ",
  description: "Kantor virtual para agen",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id" className={`${bungee.variable} ${fredoka.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

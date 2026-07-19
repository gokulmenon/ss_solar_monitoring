import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { BottomTabBar } from "@/components/app-shell/bottom-tab-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Solar Monitor",
    template: "%s | Solar Monitor",
  },
  description: "Mobile-first solar monitoring dashboard for live telemetry and history.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-[100svh]">
          <main className="mx-auto flex min-h-[100svh] w-full max-w-[430px] flex-col px-4 pb-32 pt-4 sm:max-w-[720px] md:max-w-[960px] lg:max-w-[1180px] sm:px-6 lg:px-8">
            {children}
          </main>
          <BottomTabBar />
        </div>
      </body>
    </html>
  );
}

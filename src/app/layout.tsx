import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "基本法研讀 · Basic Law Study Agent",
  description:
    "An AI study assistant for the Basic Law of the HKSAR: Vercel AI SDK agent loop, MCP tools, Prisma + PostgreSQL, Azure OpenAI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The interface is in Chinese; the corpus is the Government's English booklet, so article text stays English
    // and is marked as such where it appears. lang is the document's own language, not the corpus's.
    // suppressHydrationWarning: the inline script below stamps data-theme on <html> before React hydrates, so the
    // server markup and the client DOM differ on that one attribute by design.
    <html lang="zh-Hant-HK" className="h-full" suppressHydrationWarning>
      <head>
        {/* Same stylesheet the design canvas uses. Loaded as a link rather than through next/font because the
            CJK families are large and next/font would pull the whole set into the build. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- this IS the App Router root layout, so
            the stylesheet is added once for every route; the rule targets the pages/_document case. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600;700&family=Noto+Sans+SC:wght@300;400;500;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Apply the stored theme before first paint so navigating between routes never flashes the other one. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("bl-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}',
          }}
        />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}

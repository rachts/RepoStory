import type { Metadata } from "next";
import { REPOSTORY_ICON_PATH, REPOSTORY_MARK_PATH } from "@/components/RepoStoryBrand";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepoStory — Explain your repository",
  description:
    "Turn a public GitHub repository into a story people can understand.",
  icons: {
    icon: [
      { url: REPOSTORY_MARK_PATH, type: "image/png", sizes: "512x512" },
      { url: "/favicon.ico", type: "image/x-icon" },
    ],
    shortcut: [REPOSTORY_MARK_PATH],
    apple: [{ url: REPOSTORY_MARK_PATH, type: "image/png", sizes: "512x512" }],
  },
  openGraph: {
    title: "RepoStory — Explain your repository",
    description: "Turn a public GitHub repository into a story people can understand.",
    type: "website",
    images: [{ url: REPOSTORY_ICON_PATH, width: 669, height: 373, alt: "RepoStory" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "RepoStory — Explain your repository",
    description: "Turn a public GitHub repository into a story people can understand.",
    images: [REPOSTORY_ICON_PATH],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

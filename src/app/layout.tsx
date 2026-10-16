import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepoStory — Explain your repository",
  description:
    "Turn a public GitHub repository into a story people can understand.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "橘子集 · 西交利物浦大学校园二手交易",
  description: "SIP 校区与太仓校区的闲置好物，登录后发布和收藏。",
  icons: {
    icon: "/assets/orange.svg",
    shortcut: "/assets/orange.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}

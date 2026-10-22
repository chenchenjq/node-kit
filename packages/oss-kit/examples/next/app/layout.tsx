import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body style={{ margin: 0, padding: "2rem", background: "#f5f7fa" }}>{children}</body></html>; }

import type { ReactNode } from "react";
import "./styles.css";

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <html lang="zh-CN">
    <head><title>addr-parse-kit 示例</title></head>
    <body>{children}</body>
  </html>;
}

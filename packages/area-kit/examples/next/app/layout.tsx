import type { ReactNode } from "react";
import "./styles.css";

export default function RootLayout({children}: {children: ReactNode}): React.JSX.Element {
  return <html lang="zh-CN"><body>
    <header><a href="/">区域地址示例</a><nav aria-label="主导航"><a href="/areas">选择地址</a><a href="/admin/areas">区域管理</a></nav></header>
    {children}
  </body></html>;
}

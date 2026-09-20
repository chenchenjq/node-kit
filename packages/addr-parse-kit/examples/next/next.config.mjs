/**
 * 示例宿主配置：相对导入一律不带扩展名，因此 webpack 与 Turbopack 都能构建。
 * distDir 只在打包验收脚本里改（用于把“越界导入”的失败构建和正常构建分开存证）。
 */
export default {
  distDir: process.env.ADDR_PARSE_NEXT_DIST ?? ".next",
};

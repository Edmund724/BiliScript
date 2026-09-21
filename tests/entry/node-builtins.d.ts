// node 内建模块的最小类型垫片：对齐 tests/bilibili/node-builtins.d.ts 的先例——
// 根 tsconfig 未装 @types/node，本目录测试只用到 node:fs 的这一个额外成员
// （readFileSync 等已有声明经模块声明合并自动叠加）。若将来根配置引入
// @types/node，本文件应直接删除。
declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

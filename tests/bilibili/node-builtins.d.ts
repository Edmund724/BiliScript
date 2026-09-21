// node 内建模块的最小类型垫片：根 tsconfig 未装 @types/node（也不归本目录管），
// 本目录测试只用到以下三个模块的这几个成员，逐字对齐 node 真实签名。
// 若将来根配置引入 @types/node，本文件应直接删除。
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  const path: {
    dirname(p: string): string;
    resolve(...paths: string[]): string;
  };
  export default path;
}

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

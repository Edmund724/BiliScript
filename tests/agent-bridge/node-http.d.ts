// Minimal Node.js type stubs for agent-bridge installer tests (tsconfig intentionally excludes @types/node).
declare module "node:fs" {
  export function chmodSync(path: string, mode: number): void;
}

declare module "node:http" {
  export interface IncomingMessage {
    url?: string;
  }
  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    end(data?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    address(): string | { port: number } | null;
    close(callback: () => void): void;
  }
  export function createServer(
    listener: (req: IncomingMessage, res: ServerResponse) => void
  ): Server;
}

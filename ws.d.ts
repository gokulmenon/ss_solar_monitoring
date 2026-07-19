declare module "ws" {
  export class WebSocket {
    static OPEN: number;
    readyState: number;
    send(data: string): void;
  }

  export class WebSocketServer {
    clients: Set<WebSocket>;
    constructor(options?: { port: number; host?: string });
    on(event: "connection", listener: (socket: WebSocket) => void): void;
  }
}

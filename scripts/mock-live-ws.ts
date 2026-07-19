import { WebSocketServer, WebSocket } from "ws";

import { createMockLiveTelemetry } from "../lib/mock-data";

const port = Number(process.env.MOCK_WS_PORT ?? 8787);

const server = new WebSocketServer({
  port,
  host: "127.0.0.1",
});

function broadcast() {
  const payload = JSON.stringify(createMockLiveTelemetry());

  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

server.on("connection", (socket) => {
  socket.send(JSON.stringify(createMockLiveTelemetry()));
});

setInterval(broadcast, 1000);

console.log(`Mock live WebSocket running at ws://127.0.0.1:${port}`);

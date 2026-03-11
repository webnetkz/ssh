const http = require("node:http");
const { URL } = require("node:url");
const { Client } = require("ssh2");
const { WebSocket, WebSocketServer } = require("ws");

const HTTP_HOST = process.env.HTTP_HOST || process.env.WS_HOST || "0.0.0.0";
const HTTP_PORT = Number(process.env.HTTP_PORT || process.env.WS_PORT || 8787);
const WS_PATH = normalizeWsPath(process.env.WS_PATH || "/ws");
const GATEWAY_API_KEY = String(process.env.GATEWAY_API_KEY || "").trim();
const ALLOWED_ORIGINS = parseCsv(process.env.ALLOWED_ORIGINS || "");
const SSH_HOST_ALLOWLIST = parseCsv(process.env.SSH_HOST_ALLOWLIST || "");
const MAX_CONNECTIONS_PER_IP = Math.max(1, Number(process.env.MAX_CONNECTIONS_PER_IP || 5));

const activeConnectionsByIp = new Map();

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing URL" }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "ssh-gateway",
        wsPath: WS_PATH,
        time: new Date().toISOString()
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname !== WS_PATH) {
    rejectUpgrade(socket, 404, "Not found");
    return;
  }

  const origin = String(request.headers.origin || "").trim();
  if (!isAllowedOrigin(origin)) {
    rejectUpgrade(socket, 403, "Origin is not allowed");
    return;
  }

  const clientIp = getClientIp(request);
  if (getConnectionCount(clientIp) >= MAX_CONNECTIONS_PER_IP) {
    rejectUpgrade(socket, 429, "Too many active connections");
    return;
  }

  const headerApiKey = String(request.headers["x-api-key"] || "").trim();
  const queryApiKey = String(requestUrl.searchParams.get("apiKey") || "").trim();
  const preAuthApiKey = headerApiKey || queryApiKey;
  const preAuthenticated = !GATEWAY_API_KEY || preAuthApiKey === GATEWAY_API_KEY;

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, {
      clientIp,
      preAuthenticated
    });
  });
});

wss.on("connection", (ws, request, context = {}) => {
  const origin = String(request.headers.origin || "").trim();
  const clientIp = context.clientIp || "unknown";

  incrementConnectionCount(clientIp);

  let isAuthenticated = Boolean(context.preAuthenticated);
  let sshClient = null;
  let sshStream = null;
  let sessionState = "idle";
  let connectTimer = null;

  ws.isAlive = true;

  const send = (type, payload = {}) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  };

  const teardown = (notifyDisconnect = false) => {
    const shouldNotify = notifyDisconnect && sessionState !== "idle";

    sessionState = "idle";

    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (sshStream) {
      try {
        sshStream.end();
      } catch {
        // no-op
      }

      try {
        sshStream.destroy();
      } catch {
        // no-op
      }

      sshStream = null;
    }

    if (sshClient) {
      try {
        sshClient.end();
      } catch {
        // no-op
      }

      sshClient = null;
    }

    if (shouldNotify) {
      send("status", { state: "disconnected" });
    }
  };

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString("utf8"));
    } catch {
      send("error", { message: "Invalid JSON message" });
      return;
    }

    const { type, payload = {} } = message;

    if (type === "connect") {
      if (sessionState !== "idle") {
        send("error", { message: "Session is already running" });
        return;
      }

      if (!isAuthenticated) {
        const providedApiKey = String(payload.apiKey || "").trim();
        if (!providedApiKey || providedApiKey !== GATEWAY_API_KEY) {
          send("error", { message: "Gateway API key is invalid" });
          return;
        }

        isAuthenticated = true;
      }

      const host = String(payload.host || "").trim();
      const port = Number(payload.port) || 22;
      const username = String(payload.username || "").trim();
      const password = typeof payload.password === "string" ? payload.password : "";
      const privateKey = typeof payload.privateKey === "string" ? payload.privateKey : "";
      const passphrase = typeof payload.passphrase === "string" ? payload.passphrase : "";

      if (!host || !username) {
        send("error", { message: "Both host and username are required" });
        return;
      }

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        send("error", { message: "Port must be between 1 and 65535" });
        return;
      }

      if (!isAllowedSshHost(host)) {
        send("error", { message: "SSH host is not allowed by gateway policy" });
        return;
      }

      if (!password && !privateKey) {
        send("error", { message: "Use password or private key" });
        return;
      }

      sessionState = "connecting";
      sshClient = new Client();
      connectTimer = setTimeout(() => {
        send("error", { message: "SSH ready timeout" });
        teardown(true);
      }, 25_000);

      sshClient.on("ready", () => {
        const cols = Number(payload.cols) || 80;
        const rows = Number(payload.rows) || 24;

        sshClient.shell(
          {
            term: payload.term || "xterm-256color",
            cols,
            rows
          },
          (error, stream) => {
            if (error) {
              send("error", { message: `Failed to start shell: ${error.message}` });
              teardown(true);
              return;
            }

            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }

            sshStream = stream;
            sessionState = "connected";
            send("status", { state: "connected" });

            stream.on("data", (chunk) => {
              send("data", { data: chunk.toString("utf8") });
            });

            if (stream.stderr) {
              stream.stderr.on("data", (chunk) => {
                send("data", { data: chunk.toString("utf8") });
              });
            }

            stream.on("close", () => {
              teardown(true);
            });
          }
        );
      });

      sshClient.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        if (!password || !prompts.length) {
          finish([]);
          return;
        }

        finish(prompts.map(() => password));
      });

      sshClient.on("error", (error) => {
        send("error", { message: `SSH error: ${error.message}` });
        teardown(true);
      });

      sshClient.on("close", () => {
        teardown(true);
      });

      sshClient.on("end", () => {
        teardown(true);
      });

      try {
        sshClient.connect({
          host,
          port,
          username,
          password: password || undefined,
          privateKey: privateKey || undefined,
          passphrase: passphrase || undefined,
          tryKeyboard: true,
          readyTimeout: 20_000,
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3
        });
      } catch (error) {
        send("error", { message: `Connection failed: ${error.message}` });
        teardown(true);
      }

      return;
    }

    if (type === "input") {
      if (sessionState !== "connected" || !sshStream) {
        return;
      }

      const data = typeof payload.data === "string" ? payload.data : "";
      if (data) {
        sshStream.write(data);
      }

      return;
    }

    if (type === "resize") {
      if (sessionState !== "connected" || !sshStream) {
        return;
      }

      const cols = Math.max(40, Number(payload.cols) || 80);
      const rows = Math.max(12, Number(payload.rows) || 24);

      try {
        sshStream.setWindow(rows, cols, 0, 0);
      } catch {
        // no-op
      }

      return;
    }

    if (type === "disconnect") {
      teardown(true);
      return;
    }

    send("error", { message: `Unknown message type: ${type}` });
  });

  ws.on("close", () => {
    teardown(false);
    decrementConnectionCount(clientIp);
  });

  ws.on("error", () => {
    teardown(false);
  });

  console.log(`[gateway] client connected ip=${clientIp} origin=${origin || "n/a"}`);
});

const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }

    client.isAlive = false;
    client.ping();
  }
}, 30_000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[gateway] listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`[gateway] websocket path: ${WS_PATH}`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[gateway] allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  } else {
    console.log("[gateway] allowed origins: any");
  }
  if (SSH_HOST_ALLOWLIST.length) {
    console.log(`[gateway] ssh host allowlist: ${SSH_HOST_ALLOWLIST.join(", ")}`);
  } else {
    console.log("[gateway] ssh host allowlist: any");
  }
});

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeWsPath(path) {
  const clean = String(path || "").trim();
  if (!clean || clean === "/") {
    return "/ws";
  }

  return clean.startsWith("/") ? clean : `/${clean}`;
}

function rejectUpgrade(socket, statusCode, message) {
  const body = JSON.stringify({ ok: false, error: message });
  socket.write(
    `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body
  );
  socket.destroy();
}

function httpStatusText(code) {
  if (code === 403) {
    return "Forbidden";
  }
  if (code === 404) {
    return "Not Found";
  }
  if (code === 429) {
    return "Too Many Requests";
  }

  return "Bad Request";
}

function getClientIp(request) {
  const xff = String(request.headers["x-forwarded-for"] || "").trim();
  if (xff) {
    return xff.split(",")[0].trim();
  }

  return request.socket.remoteAddress || "unknown";
}

function getConnectionCount(ip) {
  return activeConnectionsByIp.get(ip) || 0;
}

function incrementConnectionCount(ip) {
  const next = getConnectionCount(ip) + 1;
  activeConnectionsByIp.set(ip, next);
}

function decrementConnectionCount(ip) {
  const next = getConnectionCount(ip) - 1;
  if (next <= 0) {
    activeConnectionsByIp.delete(ip);
    return;
  }

  activeConnectionsByIp.set(ip, next);
}

function isAllowedOrigin(origin) {
  if (!ALLOWED_ORIGINS.length) {
    return true;
  }

  if (!origin) {
    return false;
  }

  return ALLOWED_ORIGINS.some((rule) => matchRule(origin, rule));
}

function isAllowedSshHost(host) {
  if (!SSH_HOST_ALLOWLIST.length) {
    return true;
  }

  return SSH_HOST_ALLOWLIST.some((rule) => matchRule(host, rule));
}

function matchRule(value, rule) {
  if (!rule || rule === "*") {
    return true;
  }

  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return value.endsWith(suffix) && value.length > suffix.length;
  }

  return value === rule;
}

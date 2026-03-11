# SSH Chrome Extension (Dark Material)

This extension opens a dedicated `SSH` tab and connects through a remote SSH gateway.

End users can install the extension and connect without running a local bridge.

## Project Structure

- `extension/` - Chrome extension (UI + WebSocket client)
- `bridge/` - SSH gateway (`WebSocket -> SSH`) for server deployment

## How It Works

1. A user installs the extension.
2. The extension connects to your `wss://.../ws` gateway.
3. The gateway opens an SSH session to the target host.

## Before Publishing the Extension

1. Deploy the gateway (see below).
2. Set your gateway values in `extension/config.js`:

```js
export const GATEWAY_URL = "wss://YOUR_GATEWAY_DOMAIN/ws";
export const GATEWAY_API_KEY = ""; // optional
```

3. Upload `extension/` to the Chrome Web Store.

After that, users only need to install the extension and click `Connect`.
The gateway address is hidden from the extension UI and is not user-editable.

## Run Gateway Locally (Development)

```bash
cd bridge
npm install
npm start
```

Default endpoints:

- Health check: `http://0.0.0.0:8787/health`
- WebSocket: `ws://0.0.0.0:8787/ws`

For local development, you can temporarily set in `extension/config.js`:

```js
export const GATEWAY_URL = "ws://127.0.0.1:8787/ws";
```

## Gateway Environment Variables

- `HTTP_HOST` (default: `0.0.0.0`)
- `HTTP_PORT` (default: `8787`)
- `WS_PATH` (default: `/ws`)
- `GATEWAY_API_KEY` (optional)
- `ALLOWED_ORIGINS` (CSV, optional)
- `SSH_HOST_ALLOWLIST` (CSV, optional)
- `MAX_CONNECTIONS_PER_IP` (default: `5`)

Example:

```bash
HTTP_HOST=0.0.0.0 \
HTTP_PORT=8787 \
WS_PATH=/ws \
ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID \
SSH_HOST_ALLOWLIST=*.example.com,host1.example.com \
npm start
```

## Security

- SSH secrets (password/private key) are not saved to `chrome.storage`.
- Use `wss://` in production (TLS via reverse proxy).
- Recommended: configure `ALLOWED_ORIGINS`, `SSH_HOST_ALLOWLIST`, and `GATEWAY_API_KEY`.

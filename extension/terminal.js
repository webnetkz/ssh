import { GATEWAY_API_KEY, GATEWAY_URL } from "./config.js";

const STORAGE_KEY = "ssh-terminal-profile-v1";
const OUTPUT_LIMIT = 200_000;

const elements = {
  host: document.getElementById("host"),
  port: document.getElementById("port"),
  username: document.getElementById("username"),
  authMethod: document.getElementById("authMethod"),
  passwordGroup: document.getElementById("passwordGroup"),
  keyGroup: document.getElementById("keyGroup"),
  password: document.getElementById("password"),
  privateKey: document.getElementById("privateKey"),
  passphrase: document.getElementById("passphrase"),
  connectButton: document.getElementById("connectButton"),
  connectionStatus: document.getElementById("connectionStatus"),
  connectionForm: document.getElementById("connectionForm"),
  terminalOutput: document.getElementById("terminalOutput"),
  commandForm: document.getElementById("commandForm"),
  commandInput: document.getElementById("commandInput"),
  sendButton: document.getElementById("sendButton"),
  clearOutput: document.getElementById("clearOutput"),
  sendCtrlC: document.getElementById("sendCtrlC")
};

const state = {
  socket: null,
  status: "offline",
  history: [],
  historyIndex: -1
};

init().catch((error) => {
  appendLine(`[error] ${error.message}`);
});

async function init() {
  await loadProfile();

  elements.authMethod.addEventListener("change", updateAuthVisibility);
  elements.connectionForm.addEventListener("submit", onConnectToggle);
  elements.commandForm.addEventListener("submit", onSendCommand);
  elements.clearOutput.addEventListener("click", () => {
    elements.terminalOutput.textContent = "";
  });
  elements.sendCtrlC.addEventListener("click", () => sendInput("\u0003"));
  elements.commandInput.addEventListener("keydown", onCommandInputKeyDown);
  window.addEventListener("resize", throttle(() => sendResize(), 160));

  updateAuthVisibility();
  updateUi();

  appendLine("[system] Ready. Click Connect.");

  const gatewayError = validateGatewayConfig();
  if (gatewayError) {
    appendLine(`[error] ${gatewayError}`);
  }
}

function validateGatewayConfig() {
  const url = String(GATEWAY_URL || "").trim();
  if (!url) {
    return "Gateway URL is missing in extension/config.js.";
  }

  if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
    return "Gateway URL in extension/config.js must start with ws:// or wss://.";
  }

  return "";
}

async function loadProfile() {
  if (!chrome?.storage?.local) {
    return;
  }

  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const profile = saved?.[STORAGE_KEY];
  if (!profile) {
    return;
  }

  elements.host.value = profile.host || "";
  elements.port.value = String(profile.port || 22);
  elements.username.value = profile.username || "";
  elements.authMethod.value = profile.authMethod === "privateKey" ? "privateKey" : "password";
}

async function saveProfile(profile) {
  if (!chrome?.storage?.local) {
    return;
  }

  const cleanProfile = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: cleanProfile
  });
}

function updateAuthVisibility() {
  const useKey = elements.authMethod.value === "privateKey";
  elements.passwordGroup.classList.toggle("hidden", useKey);
  elements.keyGroup.classList.toggle("hidden", !useKey);
}

async function onConnectToggle(event) {
  event.preventDefault();

  if (state.status === "online" || state.status === "connecting") {
    disconnect();
    return;
  }

  const profile = readProfile();
  const validationError = validateProfile(profile);
  if (validationError) {
    appendLine(`[error] ${validationError}`);
    return;
  }

  await saveProfile(profile);
  connect(profile);
}

function readProfile() {
  return {
    host: elements.host.value.trim(),
    port: Number(elements.port.value || 22),
    username: elements.username.value.trim(),
    authMethod: elements.authMethod.value,
    password: elements.password.value,
    privateKey: elements.privateKey.value,
    passphrase: elements.passphrase.value
  };
}

function validateProfile(profile) {
  const gatewayError = validateGatewayConfig();
  if (gatewayError) {
    return gatewayError;
  }

  if (!profile.host) {
    return "Host is required.";
  }

  if (!profile.username) {
    return "Username is required.";
  }

  if (profile.authMethod === "password" && !profile.password) {
    return "Password is required for password auth.";
  }

  if (profile.authMethod === "privateKey" && !profile.privateKey.trim()) {
    return "Private key is required for key auth.";
  }

  return "";
}

function connect(profile) {
  try {
    closeCurrentSocket("reconnect");
    state.status = "connecting";
    updateUi();

    const gatewayUrl = buildGatewayUrl();
    state.socket = new WebSocket(gatewayUrl);

    state.socket.addEventListener("open", () => {
      appendLine("[system] Gateway connected.");

      sendMessage("connect", {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password: profile.authMethod === "password" ? profile.password : "",
        privateKey: profile.authMethod === "privateKey" ? profile.privateKey : "",
        passphrase: profile.authMethod === "privateKey" ? profile.passphrase : "",
        apiKey: GATEWAY_API_KEY || undefined,
        term: "xterm-256color",
        ...measureTerminal()
      });
    });

    state.socket.addEventListener("message", (event) => {
      onSocketMessage(event.data);
    });

    state.socket.addEventListener("error", () => {
      appendLine("[error] Failed to connect SSH gateway.");
    });

    state.socket.addEventListener("close", () => {
      if (state.status !== "offline") {
        appendLine("[system] Connection closed.");
      }
      state.status = "offline";
      state.socket = null;
      updateUi();
    });
  } catch (error) {
    appendLine(`[error] ${error.message}`);
    state.status = "offline";
    updateUi();
  }
}

function buildGatewayUrl() {
  const source = String(GATEWAY_URL || "").trim();
  const url = new URL(source);
  url.searchParams.set("client", "chrome-extension");
  return url.toString();
}

function disconnect() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    sendMessage("disconnect", {});
  }
  closeCurrentSocket("client disconnect");

  state.status = "offline";
  updateUi();
}

function onSocketMessage(rawMessage) {
  let message = null;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    appendLine("[error] Gateway sent invalid JSON.");
    return;
  }

  if (message.type === "status") {
    if (message.payload?.state === "connected") {
      state.status = "online";
      appendLine("[system] SSH connected.");
      updateUi();
      elements.commandInput.focus();
      sendResize();
      return;
    }

    if (message.payload?.state === "disconnected") {
      state.status = "offline";
      appendLine("[system] SSH disconnected.");
      updateUi();
      closeCurrentSocket("ssh disconnected");
      return;
    }
  }

  if (message.type === "data") {
    appendRaw(message.payload?.data || "");
    return;
  }

  if (message.type === "error") {
    appendLine(`[error] ${message.payload?.message || "Unknown gateway error"}`);
    state.status = "offline";
    updateUi();
    closeCurrentSocket("ssh error");
  }
}

function onSendCommand(event) {
  event.preventDefault();

  if (state.status !== "online") {
    return;
  }

  const command = elements.commandInput.value;
  if (!command) {
    return;
  }

  sendInput(`${command}\n`);
  addToHistory(command);
  elements.commandInput.value = "";
}

function onCommandInputKeyDown(event) {
  if (!state.history.length) {
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    state.historyIndex = Math.min(state.historyIndex + 1, state.history.length - 1);
    const value = state.history[state.history.length - 1 - state.historyIndex];
    elements.commandInput.value = value;
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.historyIndex = Math.max(state.historyIndex - 1, -1);
    if (state.historyIndex === -1) {
      elements.commandInput.value = "";
      return;
    }

    const value = state.history[state.history.length - 1 - state.historyIndex];
    elements.commandInput.value = value;
  }
}

function addToHistory(command) {
  state.history.push(command);
  if (state.history.length > 100) {
    state.history = state.history.slice(-100);
  }
  state.historyIndex = -1;
}

function sendInput(data) {
  sendMessage("input", { data });
}

function sendResize() {
  if (state.status !== "online") {
    return;
  }

  sendMessage("resize", measureTerminal());
}

function sendMessage(type, payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.socket.send(
    JSON.stringify({
      type,
      payload
    })
  );
}

function closeCurrentSocket(reason = "client close") {
  if (!state.socket) {
    return;
  }

  if (
    state.socket.readyState === WebSocket.CONNECTING ||
    state.socket.readyState === WebSocket.OPEN
  ) {
    state.socket.close(1000, reason);
  }

  state.socket = null;
}

function measureTerminal() {
  const width = elements.terminalOutput.clientWidth || 800;
  const height = elements.terminalOutput.clientHeight || 360;

  const cols = Math.max(40, Math.floor(width / 8.2));
  const rows = Math.max(12, Math.floor(height / 18));

  return { cols, rows };
}

function updateUi() {
  const isOnline = state.status === "online";
  const isConnecting = state.status === "connecting";

  elements.connectButton.textContent = isOnline || isConnecting ? "Disconnect" : "Connect";
  elements.commandInput.disabled = !isOnline;
  elements.sendButton.disabled = !isOnline;
  elements.sendCtrlC.disabled = !isOnline;

  elements.connectionStatus.classList.remove("offline", "connecting", "online");
  elements.connectionStatus.classList.add(state.status);

  if (isOnline) {
    elements.connectionStatus.textContent = "Online";
    return;
  }

  if (isConnecting) {
    elements.connectionStatus.textContent = "Connecting";
    return;
  }

  elements.connectionStatus.textContent = "Offline";
}

function appendLine(line) {
  appendRaw(`${line}\n`);
}

function appendRaw(text) {
  if (!text) {
    return;
  }

  const output = elements.terminalOutput;
  output.textContent += text;

  if (output.textContent.length > OUTPUT_LIMIT) {
    output.textContent = output.textContent.slice(output.textContent.length - OUTPUT_LIMIT);
  }

  output.scrollTop = output.scrollHeight;
}

function throttle(fn, waitMs) {
  let lastRun = 0;
  let timeoutId = null;

  return (...args) => {
    const now = Date.now();
    const elapsed = now - lastRun;

    if (elapsed >= waitMs) {
      lastRun = now;
      fn(...args);
      return;
    }

    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      lastRun = Date.now();
      fn(...args);
    }, waitMs - elapsed);
  };
}

const VERSION = "0.4.0";
const ALLOWED_SCHEMES = new Set(["socks5", "https", "http"]);
const ACTION_ICON_SIZES = [16, 24, 32, 48, 64, 128];
const DISCOVERY_SCHEMES_BY_PRIORITY = {
  socks5: ["socks5", "http", "https"],
  http: ["http", "socks5", "https"],
  https: ["https", "http", "socks5"]
};
const DISCOVERY_PORTS = {
  socks5: [1080, 1085, 2080],
  http: [8080, 3128, 8000, 80],
  https: [443, 8443]
};
let activeIconCachePromise = null;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeProxyProfile(input = {}) {
  const scheme = normalizeText(input.proxyScheme).toLowerCase();
  const port = Number.parseInt(String(input.proxyPort ?? ""), 10);

  return {
    profileName: normalizeText(input.profileName) || "proxy",
    proxyScheme: ALLOWED_SCHEMES.has(scheme) ? scheme : "socks5",
    proxyHost: normalizeText(input.proxyHost),
    proxyPort: Number.isInteger(port) ? port : 1080,
    bypassList: normalizeText(input.bypassList) || "<local>, localhost, 127.0.0.1"
  };
}

function validateProxyProfile(input) {
  const profile = normalizeProxyProfile(input);

  if (!profile.proxyHost || /\s/.test(profile.proxyHost)) {
    return { ok: false, error: "Proxy host is required and must not contain spaces." };
  }

  if (!Number.isInteger(profile.proxyPort) || profile.proxyPort < 1 || profile.proxyPort > 65535) {
    return { ok: false, error: "Proxy port must be in range 1-65535." };
  }

  if (!ALLOWED_SCHEMES.has(profile.proxyScheme)) {
    return { ok: false, error: "Proxy type must be socks5, https, or http." };
  }

  return { ok: true, profile };
}

function parseBypassList(input) {
  return String(input ?? "")
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildChromeProxyValue(profileInput) {
  const profile = normalizeProxyProfile(profileInput);
  const bypassList = parseBypassList(profile.bypassList);

  const rules = {
    singleProxy: {
      scheme: profile.proxyScheme,
      host: profile.proxyHost,
      port: profile.proxyPort
    }
  };

  if (bypassList.length) {
    rules.bypassList = bypassList;
  }

  return {
    mode: "fixed_servers",
    rules
  };
}

function proxySet(profileInput) {
  const value = buildChromeProxyValue(profileInput);

  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: "regular" }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(value);
    });
  });
}

function proxyClear() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

function proxyStatus() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const value = details?.value || { mode: "direct" };
      const levelOfControl = details?.levelOfControl || "unknown";
      const rules = value?.rules || {};
      const active =
        rules.singleProxy || rules.proxyForHttps || rules.proxyForHttp || rules.fallbackProxy || null;

      resolve({
        ok: true,
        levelOfControl,
        mode: value.mode || "direct",
        activeProxy: active
          ? {
              scheme: String(active.scheme || "http").toLowerCase(),
              host: String(active.host || ""),
              port: Number(active.port || 0),
              bypassList: Array.isArray(rules.bypassList) ? rules.bypassList : []
            }
          : null
      });
    });
  });
}

function proxyControlConflict(levelOfControl) {
  return (
    levelOfControl === "controlled_by_other_extensions" ||
    levelOfControl === "not_controllable"
  );
}

async function fetchWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(url, {
      method: "GET",
      cache: "no-store",
      mode: "no-cors",
      redirect: "follow",
      signal: controller.signal
    });
    return true;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeProxyConnectivity() {
  const probeUrls = [
    "https://www.gstatic.com/generate_204",
    "http://neverssl.com/"
  ];

  for (const url of probeUrls) {
    if (await fetchWithTimeout(url)) {
      return true;
    }
  }

  return false;
}

function proxyFailureHint(profile) {
  const hints = [];

  if (profile.proxyScheme === "socks5" && Number(profile.proxyPort) === 51820) {
    hints.push(
      "Port 51820 is typically a WireGuard UDP endpoint, not a SOCKS5 proxy service."
    );
  }

  if (profile.proxyScheme === "https") {
    hints.push(
      "HTTPS proxy type works only with TLS-enabled proxy servers. For common proxies, use HTTP."
    );
  }

  return hints.join(" ");
}

function buildDiscoveryCandidates(profileInput) {
  const profile = normalizeProxyProfile(profileInput);
  const candidates = [];
  const seen = new Set([`${profile.proxyScheme}:${profile.proxyPort}`]);
  const schemePriority =
    DISCOVERY_SCHEMES_BY_PRIORITY[profile.proxyScheme] || ["socks5", "http", "https"];

  for (const scheme of schemePriority) {
    const ports = DISCOVERY_PORTS[scheme] || [];
    for (const port of ports) {
      const key = `${scheme}:${port}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      candidates.push(
        normalizeProxyProfile({
          ...profile,
          proxyScheme: scheme,
          proxyPort: port
        })
      );
    }
  }

  return candidates;
}

async function tryAutoDiscoverProxy(profileInput) {
  const candidates = buildDiscoveryCandidates(profileInput);

  for (const candidate of candidates) {
    await proxySet(candidate);
    const reachable = await probeProxyConnectivity();
    if (reachable) {
      return {
        found: true,
        profile: candidate,
        attempts: candidates.length
      };
    }
  }

  return {
    found: false,
    profile: null,
    attempts: candidates.length
  };
}

function actionCall(method, details) {
  return new Promise((resolve) => {
    if (!chrome.action || typeof chrome.action[method] !== "function") {
      resolve(false);
      return;
    }

    chrome.action[method](details, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function createIconCanvas(size) {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }
  return new OffscreenCanvas(size, size);
}

async function buildActiveIconImageDataMap() {
  const response = await fetch(chrome.runtime.getURL("128.png"));
  if (!response.ok) {
    throw new Error("Failed to load base icon.");
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const imageDataMap = {};

  for (const size of ACTION_ICON_SIZES) {
    const canvas = createIconCanvas(size);
    if (!canvas) {
      throw new Error("OffscreenCanvas is unavailable.");
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      continue;
    }

    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0, size, size);

    const dotX = size - Math.max(4, Math.round(size * 0.22));
    const dotY = size - Math.max(4, Math.round(size * 0.22));
    const dotRadius = Math.max(2, Math.round(size * 0.11));

    ctx.save();
    ctx.shadowColor = "rgba(44, 255, 133, 0.95)";
    ctx.shadowBlur = Math.round(size * 0.36);
    ctx.fillStyle = "rgba(44, 255, 133, 0.75)";
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotRadius * 0.86, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "#1ed760";
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
    ctx.lineWidth = Math.max(1, Math.round(size * 0.04));
    ctx.beginPath();
    ctx.arc(dotX, dotY, Math.max(1, dotRadius - ctx.lineWidth / 2), 0, Math.PI * 2);
    ctx.stroke();

    imageDataMap[String(size)] = ctx.getImageData(0, 0, size, size);
  }

  if (typeof bitmap.close === "function") {
    bitmap.close();
  }

  return imageDataMap;
}

async function setActionIconState(active) {
  if (!active) {
    await actionCall("setBadgeText", { text: "" });
    await actionCall("setIcon", { path: "128.png" });
    await actionCall("setTitle", { title: "WireGuard Browser Proxy" });
    return;
  }

  const showBadgeFallbackDot = async () => {
    await actionCall("setBadgeText", { text: "●" });
    await actionCall("setBadgeBackgroundColor", { color: [0, 0, 0, 0] });
    await actionCall("setBadgeTextColor", { color: "#1ed760" });
  };

  const clearBadge = async () => {
    await actionCall("setBadgeText", { text: "" });
    await actionCall("setBadgeBackgroundColor", { color: [0, 0, 0, 0] });
  };

  if (typeof OffscreenCanvas === "undefined") {
    await actionCall("setIcon", { path: "128.png" });
    await showBadgeFallbackDot();
    await actionCall("setTitle", { title: "WireGuard Browser Proxy: Active" });
    return;
  }

  if (!activeIconCachePromise) {
    activeIconCachePromise = buildActiveIconImageDataMap();
  }

  try {
    const imageDataMap = await activeIconCachePromise;
    await actionCall("setIcon", { imageData: imageDataMap });
    await clearBadge();
  } catch (_error) {
    activeIconCachePromise = null;
    await actionCall("setIcon", { path: "128.png" });
    await showBadgeFallbackDot();
  }

  await actionCall("setTitle", { title: "WireGuard Browser Proxy: Active" });
}

async function syncActionIndicatorFromProxyStatus() {
  try {
    const status = await proxyStatus();
    const active = status.mode === "fixed_servers" && Boolean(status.activeProxy);
    await setActionIconState(active);
  } catch (_error) {
    await setActionIconState(false);
  }
}

async function handleMessage(message) {
  const action = message?.action;

  if (action === "ping") {
    return {
      ok: true,
      version: VERSION,
      mode: "browser-proxy"
    };
  }

  if (action === "proxy.status") {
    return proxyStatus();
  }

  if (action === "proxy.enable") {
    const validation = validateProxyProfile(message?.profile || {});
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    const status = await proxyStatus();
    if (proxyControlConflict(status.levelOfControl)) {
      return {
        ok: false,
        error: "Proxy settings are controlled by another extension or policy."
      };
    }

    let appliedProfile = validation.profile;
    let warning = "";

    await proxySet(appliedProfile);
    let reachable = await probeProxyConnectivity();

    if (!reachable) {
      const discovered = await tryAutoDiscoverProxy(appliedProfile);
      if (discovered.found && discovered.profile) {
        appliedProfile = discovered.profile;
        reachable = true;
        warning = `Auto-detected working proxy: ${appliedProfile.proxyScheme.toUpperCase()} ${appliedProfile.proxyHost}:${appliedProfile.proxyPort}`;
      }
    }

    if (!reachable) {
      await proxyClear();
      await syncActionIndicatorFromProxyStatus();

      const hint = proxyFailureHint(appliedProfile);
      const messageParts = [
        "Proxy connectivity test failed, so browser proxy was reverted to direct mode.",
        "Check protocol, host, port, and authentication."
      ];

      if (hint) {
        messageParts.push(hint);
      }

      messageParts.push(
        "Automatic discovery also failed on common ports (1080/1085/2080, 8080/3128/8000/80, 443/8443)."
      );

      return {
        ok: false,
        error: messageParts.join(" ")
      };
    }

    await syncActionIndicatorFromProxyStatus();
    return {
      ok: true,
      mode: "fixed_servers",
      profile: appliedProfile,
      warning
    };
  }

  if (action === "proxy.disable") {
    const status = await proxyStatus();
    if (proxyControlConflict(status.levelOfControl)) {
      return {
        ok: false,
        error: "Proxy settings are controlled by another extension or policy."
      };
    }

    await proxyClear();
    await syncActionIndicatorFromProxyStatus();
    return {
      ok: true,
      mode: "direct"
    };
  }

  return { ok: false, error: `Unknown action: ${String(action || "")}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Unexpected background error."
      });
    });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void syncActionIndicatorFromProxyStatus();
});

chrome.runtime.onStartup.addListener(() => {
  void syncActionIndicatorFromProxyStatus();
});

if (chrome.proxy?.settings?.onChange) {
  chrome.proxy.settings.onChange.addListener(() => {
    void syncActionIndicatorFromProxyStatus();
  });
}

void syncActionIndicatorFromProxyStatus();

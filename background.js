const ALARM_NAME = "refresh-ip";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const CACHE_TTL_MS = 60 * 1000;
const MESSAGE_POPUP_GET_IP_AND_COPY = "popup-get-ip-and-copy";
const MESSAGE_OFFSCREEN_COPY_IP = "offscreen-copy-ip";

let ipCache = {
  value: null,
  updatedAt: 0
};

function isCacheValid() {
  return Boolean(ipCache.value) && Date.now() - ipCache.updatedAt < CACHE_TTL_MS;
}

function normalizeIp(raw) {
  return raw.trim().split(/\s+/)[0] || "";
}

function isLikelyIp(value) {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-f:]+$/i;
  return ipv4.test(value) || ipv6.test(value);
}

async function fetchIp() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://ifconfig.me/ip", {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch IP (${response.status})`);
    }

    const text = await response.text();
    const ip = normalizeIp(text);

    if (!ip || !isLikelyIp(ip)) {
      throw new Error("ifconfig.me returned unexpected data");
    }

    ipCache = {
      value: ip,
      updatedAt: Date.now()
    };

    return ip;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getIp(forceRefresh = false) {
  if (!forceRefresh && isCacheValid()) {
    return ipCache.value;
  }

  return fetchIp();
}

async function updateActionTitle(forceRefresh = false) {
  const ip = await getIp(forceRefresh);
  await chrome.action.setTitle({ title: ip });
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Copying fetched public IP address to the clipboard."
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!message.includes("Only a single offscreen document")) {
      throw error;
    }
  }
}

async function copyIpToClipboard(ip) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_OFFSCREEN_COPY_IP,
    payload: ip
  });

  return Boolean(response?.ok);
}

async function getCurrentIp(forceRefresh = false) {
  const ip = await getIp(forceRefresh);
  await chrome.action.setTitle({ title: ip });
  return ip;
}

async function getAndCopyCurrentIp(forceRefresh = false) {
  const ip = await getCurrentIp(forceRefresh);
  const copied = await copyIpToClipboard(ip);
  return { ip, copied };
}

async function init() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

  try {
    await updateActionTitle(true);
  } catch (error) {
    // Ignore initialization failures; next alarm/click will retry.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void init();
});

chrome.runtime.onStartup.addListener(() => {
  void init();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  void updateActionTitle(true).catch(() => {
    // Ignore periodic failures; next alarm/click will retry.
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_POPUP_GET_IP_AND_COPY) {
    void getAndCopyCurrentIp(false)
      .then(({ ip, copied }) => {
        sendResponse({ ok: true, ip, copied });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message || error || "Unknown error")
        });
      });

    return true;
  }
});

const COMPANY_PATTERNS = [
  { company: "Google", patterns: ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "googleadservices.com"] },
  { company: "Meta Platforms", patterns: ["facebook.net", "facebook.com/tr", "connect.facebook.net"] },
  { company: "Microsoft", patterns: ["bing.com", "clarity.ms"] },
  { company: "Amazon", patterns: ["amazon-adsystem.com", "adsystem.com"] },
  { company: "TikTok", patterns: ["analytics.tiktok.com", "tiktok.com"] },
  { company: "Yandex", patterns: ["mc.yandex.ru", "yandex.ru/metrika"] },
  { company: "Hotjar", patterns: ["hotjar.com", "hotjar.io"] }
];

const TRACKER_PATTERNS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googleadservices.com",
  "facebook.net",
  "connect.facebook.net",
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
  "segment.com",
  "mixpanel.com",
  "taboola.com",
  "outbrain.com",
  "adsystem.com",
  "amazon-adsystem.com",
  "analytics.tiktok.com"
];

const tabStats = new Map();

function ensureTabStats(tabId) {
  if (!tabStats.has(tabId)) {
    tabStats.set(tabId, {
      trackerHosts: new Set(),
      companies: new Set(),
      totalRequests: 0
    });
  }
  return tabStats.get(tabId);
}

function getHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isTracker(host) {
  return TRACKER_PATTERNS.some((pattern) => host.includes(pattern));
}

function detectCompany(host, url) {
  for (const entry of COMPANY_PATTERNS) {
    if (entry.patterns.some((pattern) => host.includes(pattern) || url.includes(pattern))) {
      return entry.company;
    }
  }
  return null;
}

function computeScore({ trackerCount, companyCount, cookieCount }) {
  let score = 100;
  score -= Math.min(50, trackerCount * 8);
  score -= Math.min(20, companyCount * 5);
  score -= Math.min(30, Math.floor(cookieCount / 3) * 3);
  return Math.max(0, score);
}

function scoreStatus(score) {
  if (score >= 75) return { label: "Good", color: "green" };
  if (score >= 45) return { label: "Medium", color: "yellow" };
  return { label: "Bad", color: "red" };
}

async function getCookieCountForTab(tab) {
  if (!tab || !tab.url) return 0;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return 0;
  }
  if (!/^https?:$/.test(url.protocol)) return 0;
  const cookies = await chrome.cookies.getAll({ domain: url.hostname });
  return cookies.length;
}

async function getSettings() {
  const defaults = {
    trackerBlocking: false,
    fingerprintProtection: true,
    cookieWarnings: true
  };
  return chrome.storage.sync.get(defaults);
}

async function setTrackerBlocking(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? ["tracker_blocklist"] : [],
    disableRulesetIds: enabled ? [] : ["tracker_blocklist"]
  });
  await chrome.storage.sync.set({ trackerBlocking: enabled });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await setTrackerBlocking(Boolean(settings.trackerBlocking));
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const host = getHost(details.url);
    if (!host) return;

    const stats = ensureTabStats(details.tabId);
    stats.totalRequests += 1;

    if (isTracker(host)) {
      stats.trackerHosts.add(host);
      const company = detectCompany(host, details.url);
      if (company) stats.companies.add(company);
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabStats.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_TAB_REPORT") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }

      const stats = ensureTabStats(tab.id);
      const trackerCount = stats.trackerHosts.size;
      const companies = Array.from(stats.companies).sort();
      const cookieCount = await getCookieCountForTab(tab);
      const settings = await getSettings();
      const score = computeScore({
        trackerCount,
        companyCount: companies.length,
        cookieCount
      });
      const status = scoreStatus(score);

      sendResponse({
        ok: true,
        data: {
          trackerCount,
          companies,
          cookieCount,
          score,
          status,
          settings,
          cookieWarning: settings.cookieWarnings && cookieCount >= 10
        }
      });
    })();
    return true;
  }

  if (message?.type === "UPDATE_SETTINGS") {
    (async () => {
      const nextSettings = {
        trackerBlocking: Boolean(message.payload?.trackerBlocking),
        fingerprintProtection: Boolean(message.payload?.fingerprintProtection),
        cookieWarnings: Boolean(message.payload?.cookieWarnings)
      };

      await chrome.storage.sync.set(nextSettings);
      await setTrackerBlocking(nextSettings.trackerBlocking);

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        await chrome.tabs.sendMessage(activeTab.id, {
          type: "SETTINGS_UPDATED",
          payload: nextSettings
        }).catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GET_SETTINGS") {
    (async () => {
      sendResponse({ ok: true, data: await getSettings() });
    })();
    return true;
  }
});

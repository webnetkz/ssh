const clearButton = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function removeOneDataType(origin, dataType) {
  return new Promise((resolve) => {
    chrome.browsingData.remove({ origins: [origin], since: 0 }, { [dataType]: true }, () => {
      const err = chrome.runtime.lastError;
      if (!err) {
        resolve({ ok: true, dataType });
        return;
      }

      const message = err.message || "";
      const unsupported =
        message.includes("not supported") ||
        message.includes("not allowed") ||
        message.includes("Invalid value");

      resolve({ ok: false, dataType, unsupported, message });
    });
  });
}

async function removeBrowsingDataForOrigin(origin) {
  const requestedTypes = [
    "cookies",
    "localStorage",
    "indexedDB",
    "cacheStorage",
    "serviceWorkers",
    "fileSystems",
    "cache"
  ];

  const failed = [];
  for (const dataType of requestedTypes) {
    const result = await removeOneDataType(origin, dataType);
    if (!result.ok && !result.unsupported) {
      failed.push(result);
    }
  }

  if (failed.length === requestedTypes.length && failed.length > 0) {
    throw new Error(failed[0].message || "Failed to remove site data.");
  }
}

function getCookiesForHostname(hostname) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ domain: hostname }, (cookies) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(cookies || []);
    });
  });
}

function removeCookie(cookie) {
  return new Promise((resolve) => {
    const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
    const scheme = cookie.secure ? "https" : "http";
    const url = `${scheme}://${host}${cookie.path || "/"}`;
    const details = {
      url,
      name: cookie.name,
      storeId: cookie.storeId
    };

    if (cookie.partitionKey && cookie.partitionKey.topLevelSite) {
      details.partitionKey = cookie.partitionKey;
    }

    chrome.cookies.remove(details, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, message: err.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function clearCookiesForUrl(currentUrl) {
  if (!chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    return;
  }

  const cookies = await getCookiesForHostname(currentUrl.hostname);
  if (cookies.length === 0) {
    return;
  }

  await Promise.all(cookies.map((cookie) => removeCookie(cookie)));
}

function clearInPageContext(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: async () => {
          const safe = async (job) => {
            try {
              await job();
            } catch (err) {
              console.debug("Clean Site warning:", err);
            }
          };

          await safe(async () => {
            window.localStorage.clear();
            window.sessionStorage.clear();
          });

          await safe(async () => {
            if (!("caches" in window)) return;
            const keys = await caches.keys();
            await Promise.all(keys.map((key) => caches.delete(key)));
          });

          await safe(async () => {
            if (!("serviceWorker" in navigator)) return;
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
          });

          await safe(async () => {
            if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") return;
            const databases = await indexedDB.databases();
            await Promise.all(
              databases
                .filter((db) => db && db.name)
                .map(
                  (db) =>
                    new Promise((done) => {
                      const request = indexedDB.deleteDatabase(db.name);
                      request.onsuccess = () => done();
                      request.onerror = () => done();
                      request.onblocked = () => done();
                    })
                )
            );
          });
        }
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      }
    );
  });
}

function reloadTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

async function clearCurrentSite() {
  const tab = await queryActiveTab();
  if (!tab || !tab.id || !tab.url) {
    throw new Error("Cannot read current tab.");
  }

  const currentUrl = new URL(tab.url);
  if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
    throw new Error("Open an http(s) website tab and try again.");
  }

  const origin = currentUrl.origin;
  const stepErrors = [];

  try {
    await removeBrowsingDataForOrigin(origin);
  } catch (err) {
    stepErrors.push(err);
  }

  try {
    await clearInPageContext(tab.id);
  } catch (err) {
    stepErrors.push(err);
  }

  try {
    await clearCookiesForUrl(currentUrl);
  } catch (err) {
    stepErrors.push(err);
  }

  if (stepErrors.length === 3) {
    throw stepErrors[0] instanceof Error
      ? stepErrors[0]
      : new Error("Failed to clean current site.");
  }

  await reloadTab(tab.id);

  return origin;
}

clearButton.addEventListener("click", async () => {
  clearButton.disabled = true;
  setStatus("Cleaning data...");

  try {
    const origin = await clearCurrentSite();
    setStatus(`Done. Cleaned: ${origin}`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to clean current site.", true);
  } finally {
    clearButton.disabled = false;
  }
});

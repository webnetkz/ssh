const STORAGE_KEY = "fingerprintProtection";
let isInjected = false;

function injectProtection() {
  if (isInjected) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/fingerprint-page.js");
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
  isInjected = true;
}

chrome.storage.sync.get({ [STORAGE_KEY]: true }, (result) => {
  if (result[STORAGE_KEY]) {
    injectProtection();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SETTINGS_UPDATED" && message.payload?.fingerprintProtection) {
    injectProtection();
  }
});

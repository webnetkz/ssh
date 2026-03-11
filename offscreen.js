chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "offscreen-copy-ip") {
    return;
  }

  (async () => {
    try {
      await navigator.clipboard.writeText(String(message.payload || ""));
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false });
    }
  })();

  return true;
});

const TERMINAL_PAGE = "terminal.html";

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(TERMINAL_PAGE)
  });
});

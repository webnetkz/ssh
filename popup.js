const ipElement = document.getElementById("ip");

async function loadIpAndCopy() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "popup-get-ip-and-copy" });
    if (response?.ok && response.ip) {
      ipElement.textContent = response.ip;
      return;
    }
  } catch (error) {
    // Ignore and keep popup empty when IP cannot be retrieved.
  }

  ipElement.textContent = "";
}

void loadIpAndCopy();

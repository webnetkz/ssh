const scoreValue = document.getElementById("scoreValue");
const scoreStatus = document.getElementById("scoreStatus");
const trackerCount = document.getElementById("trackerCount");
const cookieCount = document.getElementById("cookieCount");
const companiesList = document.getElementById("companiesList");
const cookieWarning = document.getElementById("cookieWarning");

const trackerBlockingInput = document.getElementById("trackerBlocking");
const fingerprintProtectionInput = document.getElementById("fingerprintProtection");
const cookieWarningsInput = document.getElementById("cookieWarnings");

function renderCompanies(companies) {
  companiesList.innerHTML = "";
  if (!companies.length) {
    const li = document.createElement("li");
    li.textContent = "None detected";
    companiesList.appendChild(li);
    return;
  }
  for (const company of companies) {
    const li = document.createElement("li");
    li.textContent = company;
    companiesList.appendChild(li);
  }
}

function renderStatus(status) {
  scoreStatus.textContent =
    status.color === "green"
      ? "🟢 Good"
      : status.color === "yellow"
        ? "🟡 Medium"
        : "🔴 Bad";
  scoreStatus.className = `badge ${
    status.color === "green"
      ? "good"
      : status.color === "yellow"
        ? "medium"
        : "bad"
  }`;
}

async function updateSettings() {
  await chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    payload: {
      trackerBlocking: trackerBlockingInput.checked,
      fingerprintProtection: fingerprintProtectionInput.checked,
      cookieWarnings: cookieWarningsInput.checked
    }
  });
  await loadReport();
}

async function loadReport() {
  const report = await chrome.runtime.sendMessage({ type: "GET_TAB_REPORT" });
  if (!report.ok) {
    scoreValue.textContent = "--";
    scoreStatus.textContent = "No data";
    return;
  }

  const data = report.data;
  scoreValue.textContent = String(data.score);
  renderStatus(data.status);
  trackerCount.textContent = String(data.trackerCount);
  cookieCount.textContent = String(data.cookieCount);
  renderCompanies(data.companies);

  trackerBlockingInput.checked = Boolean(data.settings.trackerBlocking);
  fingerprintProtectionInput.checked = Boolean(data.settings.fingerprintProtection);
  cookieWarningsInput.checked = Boolean(data.settings.cookieWarnings);

  cookieWarning.classList.toggle("hidden", !data.cookieWarning);
}

trackerBlockingInput.addEventListener("change", updateSettings);
fingerprintProtectionInput.addEventListener("change", updateSettings);
cookieWarningsInput.addEventListener("change", updateSettings);

loadReport();

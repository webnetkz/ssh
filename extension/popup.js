import {
  DEFAULT_PROXY_PROFILE,
  normalizeProxyProfile,
  parseEndpointHostPort,
  parseProxyConfig,
  proxyMeta,
  validateProxyProfile
} from "./lib/proxy-config.js";

const STORAGE_PROFILES_KEY = "wireguard.profiles";
const STORAGE_SELECTED_PROFILE_KEY = "wireguard.selectedProfile";
const STORAGE_PROFILE_STATES_KEY = "wireguard.profileStates";
const LEGACY_PROFILE_KEY = "wireguard.profile";
const LEGACY_STATE_KEY = "wireguard.state";

const fieldIds = ["profileName", "proxyScheme", "proxyHost", "proxyPort", "bypassList"];

const elements = {
  tabMain: document.getElementById("tabMain"),
  tabSettings: document.getElementById("tabSettings"),
  panelMain: document.getElementById("panelMain"),
  panelSettings: document.getElementById("panelSettings"),
  profilesList: document.getElementById("profilesList"),
  profilesEmpty: document.getElementById("profilesEmpty"),
  configFile: document.getElementById("configFile"),
  pickFileButton: document.getElementById("pickFileButton"),
  schemeHint: document.getElementById("schemeHint"),
  message: document.getElementById("message"),
  profileSelect: document.getElementById("profileSelect"),
  newProfileButton: document.getElementById("newProfileButton"),
  deleteProfileButton: document.getElementById("deleteProfileButton"),
  saveSettingsButton: document.getElementById("saveSettingsButton")
};

const fields = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));

let profiles = [];
let selectedProfileName = "";
let profileStates = {};
let proxyControllable = true;
const pendingProfiles = new Set();

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, resolve);
  });
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || { ok: false, error: "No response from background." });
    });
  });
}

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function setTab(tabName) {
  const isMain = tabName === "main";

  elements.tabMain.classList.toggle("active", isMain);
  elements.tabSettings.classList.toggle("active", !isMain);
  elements.tabMain.setAttribute("aria-selected", String(isMain));
  elements.tabSettings.setAttribute("aria-selected", String(!isMain));

  elements.panelMain.classList.toggle("active", isMain);
  elements.panelSettings.classList.toggle("active", !isMain);

  elements.panelMain.hidden = !isMain;
  elements.panelSettings.hidden = isMain;
}

function collectProfileFromForm() {
  const profile = {};
  for (const id of fieldIds) {
    profile[id] = fields[id].value;
  }
  return normalizeProxyProfile(profile);
}

function fillForm(profileInput) {
  const profile = normalizeProxyProfile(profileInput);
  for (const id of fieldIds) {
    fields[id].value = profile[id] ?? "";
  }
  updateSchemeHint();
}

function updateSchemeHint() {
  if (!elements.schemeHint || !fields.proxyScheme) {
    return;
  }

  const scheme = String(fields.proxyScheme.value || "").toLowerCase();
  if (scheme === "https") {
    elements.schemeHint.textContent =
      "HTTPS requires a TLS-enabled proxy server with a valid certificate. If sites fail to load, try HTTP.";
    return;
  }

  if (scheme === "socks5") {
    elements.schemeHint.textContent =
      "SOCKS5 requires a SOCKS5 proxy service on this host/port.";
    return;
  }

  elements.schemeHint.textContent =
    "HTTP is the most common choice for regular proxy servers (including HTTPS websites via CONNECT).";
}

function normalizeStateMap(rawStateMap) {
  if (!rawStateMap || typeof rawStateMap !== "object") {
    return {};
  }

  const normalized = {};
  for (const [name, value] of Object.entries(rawStateMap)) {
    normalized[name] = {
      connected: Boolean(value?.connected),
      updatedAt: String(value?.updatedAt || new Date().toISOString()),
      lastError: value?.lastError ? String(value.lastError) : ""
    };
  }

  return normalized;
}

function normalizeProfiles(rawProfiles) {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const unique = new Map();
  for (const rawProfile of rawProfiles) {
    const profile = normalizeProxyProfile(rawProfile);
    unique.set(profile.profileName, profile);
  }

  return [...unique.values()];
}

function ensureUniqueName(baseName, excludeName = "") {
  const existing = new Set(profiles.map((profile) => profile.profileName));
  if (!existing.has(baseName) || baseName === excludeName) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}_${index}`.slice(0, 32);
    if (!existing.has(candidate) || candidate === excludeName) {
      return candidate;
    }
  }

  return `${Date.now()}`.slice(0, 32);
}

function profileNameFromFile(fileName) {
  const base = String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return base.slice(0, 32) || "imported_proxy";
}

function getProfileByName(profileName) {
  return profiles.find((profile) => profile.profileName === profileName) || null;
}

function getSelectedProfile() {
  return getProfileByName(selectedProfileName) || profiles[0] || null;
}

function setConnectedProfile(activeProfileName = "") {
  const nowIso = new Date().toISOString();

  for (const profile of profiles) {
    const previous = profileStates[profile.profileName] || {};
    profileStates[profile.profileName] = {
      connected: profile.profileName === activeProfileName,
      updatedAt: nowIso,
      lastError: profile.profileName === activeProfileName ? "" : previous.lastError || ""
    };
  }
}

function enforceSingleEnabledProfile() {
  const active = profiles.find((profile) => profileStates[profile.profileName]?.connected);
  setConnectedProfile(active?.profileName || "");
}

function proxyMatchesProfile(activeProxy, profile) {
  if (!activeProxy || !profile) {
    return false;
  }

  const activeScheme = String(activeProxy.scheme || "").toLowerCase();
  const activeHost = String(activeProxy.host || "").toLowerCase();
  const activePort = Number(activeProxy.port || 0);

  return (
    activeScheme === String(profile.proxyScheme).toLowerCase() &&
    activeHost === String(profile.proxyHost).toLowerCase() &&
    activePort === Number(profile.proxyPort)
  );
}

async function persistAll() {
  await storageSet({
    [STORAGE_PROFILES_KEY]: profiles,
    [STORAGE_SELECTED_PROFILE_KEY]: selectedProfileName,
    [STORAGE_PROFILE_STATES_KEY]: profileStates
  });
}

function renderProfileSelect() {
  elements.profileSelect.innerHTML = "";

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.profileName;
    option.textContent = profile.profileName;
    elements.profileSelect.append(option);
  }

  const selected = getSelectedProfile();
  if (selected) {
    selectedProfileName = selected.profileName;
    elements.profileSelect.value = selectedProfileName;
    fillForm(selected);
  }

  elements.deleteProfileButton.disabled = profiles.length <= 1;
}

function stateLabelForProfile(state, pending) {
  if (pending) {
    return { text: "Applying...", className: "" };
  }

  return state?.connected
    ? { text: "Enabled", className: "connected" }
    : { text: "Disabled", className: "" };
}

function renderProfilesList() {
  elements.profilesList.innerHTML = "";
  const hasProfiles = profiles.length > 0;
  elements.profilesEmpty.hidden = hasProfiles;

  if (!hasProfiles) {
    return;
  }

  const hasPending = pendingProfiles.size > 0;

  for (const profile of profiles) {
    const state = profileStates[profile.profileName] || {};
    const pending = pendingProfiles.has(profile.profileName);
    const label = stateLabelForProfile(state, pending);

    const item = document.createElement("li");
    item.className = "profile-item";

    const main = document.createElement("div");
    main.className = "profile-main";

    const name = document.createElement("span");
    name.className = "profile-name";
    name.textContent = profile.profileName;

    const meta = document.createElement("span");
    meta.className = "profile-meta";
    meta.textContent = proxyMeta(profile);

    const stateLine = document.createElement("span");
    stateLine.className = `profile-state ${label.className}`.trim();
    stateLine.textContent = label.text;

    main.append(name, meta, stateLine);

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "mini-button";
    editButton.textContent = "Edit";
    editButton.disabled = hasPending;
    editButton.addEventListener("click", () => {
      selectedProfileName = profile.profileName;
      renderProfileSelect();
      setTab("settings");
      persistAll().catch(() => {});
    });

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(state.connected);
    toggle.disabled = hasPending || !proxyControllable;
    toggle.addEventListener("change", async () => {
      await toggleProfile(profile.profileName, toggle.checked);
    });

    const slider = document.createElement("span");
    slider.className = "slider";

    switchLabel.append(toggle, slider);
    actions.append(editButton, switchLabel);

    item.append(main, actions);
    elements.profilesList.append(item);
  }
}

function renderAll() {
  renderProfilesList();
  renderProfileSelect();
}

function getResponseError(response, fallback) {
  if (!response) {
    return fallback;
  }

  return response.error || fallback;
}

async function fetchProxyStatus() {
  const response = await sendRuntimeMessage({ action: "proxy.status" });
  if (!response.ok) {
    throw new Error(getResponseError(response, "Failed to read proxy status."));
  }
  return response;
}

async function syncStateWithBrowserProxy(silent = false) {
  try {
    const status = await fetchProxyStatus();

    proxyControllable =
      status.levelOfControl !== "controlled_by_other_extensions" &&
      status.levelOfControl !== "not_controllable";

    if (status.mode === "fixed_servers" && status.activeProxy) {
      const matched = profiles.find((profile) => proxyMatchesProfile(status.activeProxy, profile));
      setConnectedProfile(matched?.profileName || "");
    } else {
      setConnectedProfile("");
    }

    await persistAll();
    renderProfilesList();

    if (!proxyControllable && !silent) {
      setMessage(
        "Proxy settings are controlled by another extension or browser policy.",
        true
      );
    }

    return status;
  } catch (error) {
    proxyControllable = true;
    if (!silent) {
      setMessage(error.message || "Failed to read proxy status.", true);
    }
    return null;
  }
}

async function enableProxyProfile(profileName) {
  const profile = getProfileByName(profileName);
  if (!profile) {
    throw new Error(`Profile ${profileName} was not found.`);
  }

  const validation = validateProxyProfile(profile);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }

  const response = await sendRuntimeMessage({
    action: "proxy.enable",
    profile: validation.profile
  });

  if (!response.ok) {
    throw new Error(getResponseError(response, "Failed to enable proxy."));
  }

  const appliedProfile = normalizeProxyProfile(response.profile || validation.profile);
  appliedProfile.profileName = profile.profileName;

  const profileIndex = profiles.findIndex((item) => item.profileName === profile.profileName);
  if (profileIndex !== -1) {
    profiles[profileIndex] = appliedProfile;
  }

  setConnectedProfile(profileName);

  return {
    profile: appliedProfile,
    warning: String(response.warning || "")
  };
}

async function disableProxy() {
  const response = await sendRuntimeMessage({ action: "proxy.disable" });
  if (!response.ok) {
    throw new Error(getResponseError(response, "Failed to disable proxy."));
  }

  setConnectedProfile("");
}

async function toggleProfile(profileName, enabled) {
  pendingProfiles.add(profileName);
  renderProfilesList();

  try {
    if (enabled) {
      const result = await enableProxyProfile(profileName);
      const warning = String(result.warning || "");
      const lines = [
        `Proxy enabled: ${proxyMeta(result.profile)}.`,
        "Traffic is routed through proxy in Chrome only."
      ];

      if (warning) {
        lines.push(warning);
      }

      setMessage(lines.join("\n"), warning.toLowerCase().includes("failed"));
    } else {
      await disableProxy();
      setMessage("Proxy disabled. Chrome is now using direct connection.");
    }
  } catch (error) {
    setMessage(error.message || "Proxy operation failed.", true);
    await syncStateWithBrowserProxy(true);
  } finally {
    pendingProfiles.delete(profileName);
    await persistAll();
    renderProfilesList();
  }
}

async function saveSettings() {
  const oldProfileName = selectedProfileName;
  const validation = validateProxyProfile(collectProfileFromForm());

  if (!validation.ok) {
    setMessage(validation.errors.join("\n"), true);
    return;
  }

  const profile = validation.profile;

  if (
    oldProfileName !== profile.profileName &&
    profiles.some((item) => item.profileName === profile.profileName)
  ) {
    setMessage(`Profile ${profile.profileName} already exists.`, true);
    return;
  }

  if (oldProfileName && oldProfileName !== profile.profileName) {
    profiles = profiles.filter((item) => item.profileName !== oldProfileName);
    if (profileStates[oldProfileName]) {
      profileStates[profile.profileName] = profileStates[oldProfileName];
      delete profileStates[oldProfileName];
    }
  }

  const existingIndex = profiles.findIndex((item) => item.profileName === profile.profileName);
  if (existingIndex === -1) {
    profiles.push(profile);
  } else {
    profiles[existingIndex] = profile;
  }

  selectedProfileName = profile.profileName;
  await persistAll();
  renderAll();
  setMessage(`Saved: ${profile.profileName}.`);
}

async function createNewProfile() {
  const baseName = ensureUniqueName("proxy");
  const profile = normalizeProxyProfile({
    ...DEFAULT_PROXY_PROFILE,
    profileName: baseName
  });

  profiles.push(profile);
  selectedProfileName = profile.profileName;
  profileStates[profile.profileName] = {
    connected: false,
    updatedAt: new Date().toISOString(),
    lastError: ""
  };

  await persistAll();
  renderAll();
  setMessage(`New profile created: ${profile.profileName}.`);
}

async function deleteSelectedProfile() {
  const selected = getSelectedProfile();
  if (!selected) {
    return;
  }

  if (profileStates[selected.profileName]?.connected) {
    setMessage("Disable this profile before deleting it.", true);
    return;
  }

  profiles = profiles.filter((profile) => profile.profileName !== selected.profileName);
  delete profileStates[selected.profileName];

  if (!profiles.length) {
    const fallback = normalizeProxyProfile(DEFAULT_PROXY_PROFILE);
    profiles = [fallback];
    profileStates[fallback.profileName] = {
      connected: false,
      updatedAt: new Date().toISOString(),
      lastError: ""
    };
  }

  selectedProfileName = profiles[0].profileName;
  await persistAll();
  renderAll();
  setMessage(`Profile deleted: ${selected.profileName}.`);
}

function convertLegacyWireGuardProfile(raw) {
  const legacy = raw && typeof raw === "object" ? raw : {};
  const endpoint = parseEndpointHostPort(legacy.endpoint);

  return normalizeProxyProfile({
    profileName: legacy.profileName || legacy.interfaceName || "proxy",
    proxyScheme: "socks5",
    proxyHost: endpoint.host,
    proxyPort: endpoint.port
  });
}

async function importConfigFile() {
  const file = elements.configFile.files?.[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const imported = parseProxyConfig(text);

    let profileName = imported.profileName;
    if (!profileName || profileName === DEFAULT_PROXY_PROFILE.profileName) {
      profileName = profileNameFromFile(file.name);
    }

    const existing = getProfileByName(profileName);
    if (!existing) {
      profileName = ensureUniqueName(profileName);
    }

    imported.profileName = profileName;

    const normalized = normalizeProxyProfile(imported);
    const idx = profiles.findIndex((profile) => profile.profileName === normalized.profileName);

    if (idx === -1) {
      profiles.push(normalized);
    } else {
      profiles[idx] = normalized;
    }

    selectedProfileName = normalized.profileName;
    if (!profileStates[normalized.profileName]) {
      profileStates[normalized.profileName] = {
        connected: false,
        updatedAt: new Date().toISOString(),
        lastError: ""
      };
    }

    await persistAll();
    renderAll();

    const validation = validateProxyProfile(normalized);
    if (!validation.ok) {
      setMessage(
        `Imported: ${file.name} -> ${normalized.profileName}.\nComplete host/port in Settings before enabling.`,
        true
      );
    } else {
      setMessage(`Imported: ${file.name} -> ${normalized.profileName}`);
    }
  } catch (error) {
    setMessage(error.message || "Failed to import proxy file.", true);
  } finally {
    elements.configFile.value = "";
  }
}

async function loadInitialState() {
  const stored = await storageGet([
    STORAGE_PROFILES_KEY,
    STORAGE_SELECTED_PROFILE_KEY,
    STORAGE_PROFILE_STATES_KEY,
    LEGACY_PROFILE_KEY,
    LEGACY_STATE_KEY
  ]);

  profiles = normalizeProfiles(stored[STORAGE_PROFILES_KEY]);
  selectedProfileName = String(stored[STORAGE_SELECTED_PROFILE_KEY] || "").trim();
  profileStates = normalizeStateMap(stored[STORAGE_PROFILE_STATES_KEY]);

  if (!profiles.length && stored[LEGACY_PROFILE_KEY]) {
    const converted = convertLegacyWireGuardProfile(stored[LEGACY_PROFILE_KEY]);
    profiles = [converted];
    selectedProfileName = converted.profileName;

    const legacyState = stored[LEGACY_STATE_KEY] || {};
    profileStates[converted.profileName] = {
      connected: Boolean(legacyState.connected),
      updatedAt: String(legacyState.updatedAt || new Date().toISOString()),
      lastError: ""
    };
  }

  if (!profiles.length) {
    const fallback = normalizeProxyProfile(DEFAULT_PROXY_PROFILE);
    profiles = [fallback];
    selectedProfileName = fallback.profileName;
  }

  for (const profile of profiles) {
    if (!profileStates[profile.profileName]) {
      profileStates[profile.profileName] = {
        connected: false,
        updatedAt: new Date().toISOString(),
        lastError: ""
      };
    }
  }

  if (!getProfileByName(selectedProfileName)) {
    selectedProfileName = profiles[0].profileName;
  }

  enforceSingleEnabledProfile();
  await persistAll();
}

function wireEvents() {
  elements.tabMain.addEventListener("click", () => setTab("main"));
  elements.tabSettings.addEventListener("click", () => setTab("settings"));

  elements.pickFileButton.addEventListener("click", () => {
    elements.configFile.click();
  });

  elements.configFile.addEventListener("change", importConfigFile);

  elements.profileSelect.addEventListener("change", () => {
    selectedProfileName = elements.profileSelect.value;
    const selected = getSelectedProfile();
    if (selected) {
      fillForm(selected);
    }
    persistAll().catch(() => {});
  });

  elements.newProfileButton.addEventListener("click", createNewProfile);
  elements.deleteProfileButton.addEventListener("click", deleteSelectedProfile);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  fields.proxyScheme.addEventListener("change", updateSchemeHint);
}

async function init() {
  wireEvents();
  setTab("main");

  await loadInitialState();
  renderAll();

  const status = await syncStateWithBrowserProxy(true);

  if (!status) {
    setMessage("Proxy mode is ready. Enable a profile to route Chrome traffic via proxy.");
    return;
  }

  if (!proxyControllable) {
    setMessage(
      "Proxy settings are controlled by another extension or browser policy.",
      true
    );
    return;
  }

  if (status.mode === "fixed_servers" && status.activeProxy) {
    setMessage(
      `Current browser proxy: ${String(status.activeProxy.scheme || "").toUpperCase()} ${status.activeProxy.host}:${status.activeProxy.port}`
    );
    return;
  }

  setMessage("Ready. Enable a profile to route Chrome traffic via proxy.");
}

document.addEventListener("DOMContentLoaded", init);

export const DEFAULT_PROXY_PROFILE = {
  profileName: "proxy",
  proxyScheme: "socks5",
  proxyHost: "",
  proxyPort: "1080",
  bypassList: "<local>, localhost, 127.0.0.1"
};

const ALLOWED_SCHEMES = new Set(["socks5", "https", "http"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeHost(value) {
  const host = normalizeText(value);
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1).trim();
  }
  return host;
}

export function normalizeProxyProfile(input = {}) {
  const scheme = normalizeText(input.proxyScheme).toLowerCase();

  return {
    profileName: normalizeText(input.profileName) || DEFAULT_PROXY_PROFILE.profileName,
    proxyScheme: ALLOWED_SCHEMES.has(scheme) ? scheme : DEFAULT_PROXY_PROFILE.proxyScheme,
    proxyHost: normalizeHost(input.proxyHost),
    proxyPort: normalizeText(input.proxyPort) || DEFAULT_PROXY_PROFILE.proxyPort,
    bypassList: normalizeText(input.bypassList) || DEFAULT_PROXY_PROFILE.bypassList
  };
}

function parsePort(value) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function splitHostAndPort(rawValue) {
  const raw = normalizeText(rawValue);
  if (!raw) {
    return { host: "", port: "" };
  }

  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    if (closing !== -1) {
      const host = normalizeHost(raw.slice(0, closing + 1));
      const tail = raw.slice(closing + 1).trim();
      if (tail.startsWith(":")) {
        return { host, port: tail.slice(1).trim() };
      }
      return { host, port: "" };
    }
  }

  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount === 1) {
    const separator = raw.lastIndexOf(":");
    const host = normalizeHost(raw.slice(0, separator));
    const port = raw.slice(separator + 1).trim();
    if (host && /^\d+$/.test(port)) {
      return { host, port };
    }
  }

  return { host: normalizeHost(raw), port: "" };
}

function parsedPortOrDefault(value) {
  const port = parsePort(value);
  return port === null ? DEFAULT_PROXY_PROFILE.proxyPort : String(port);
}

export function validateProxyProfile(input) {
  const profile = normalizeProxyProfile(input);
  const errors = [];

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(profile.profileName)) {
    errors.push("Profile name: use 1-32 symbols [a-zA-Z0-9_-].");
  }

  if (!ALLOWED_SCHEMES.has(profile.proxyScheme)) {
    errors.push("Proxy type must be one of: socks5, https, http.");
  }

  if (!profile.proxyHost || /\s/.test(profile.proxyHost)) {
    errors.push("Proxy host is required and should not contain spaces.");
  }

  if (parsePort(profile.proxyPort) === null) {
    errors.push("Proxy port must be in range 1-65535.");
  }

  return {
    ok: errors.length === 0,
    errors,
    profile
  };
}

function parseUri(rawText) {
  const text = String(rawText || "").trim();
  if (!text || !text.includes("://")) {
    return null;
  }

  let url;
  try {
    url = new URL(text);
  } catch (_error) {
    return null;
  }

  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return null;
  }

  return normalizeProxyProfile({
    proxyScheme: scheme,
    proxyHost: normalizeHost(url.hostname),
    proxyPort: url.port || DEFAULT_PROXY_PROFILE.proxyPort,
    bypassList: url.searchParams.get("bypass") || DEFAULT_PROXY_PROFILE.bypassList
  });
}

function parseKeyValueConfig(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const parsed = {};
  let hasExplicitPort = false;

  for (const line of lines) {
    const clean = line.replace(/[;#].*$/, "").trim();
    if (!clean) {
      continue;
    }

    const separatorIndex = clean.includes("=") ? clean.indexOf("=") : clean.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = clean.slice(0, separatorIndex).trim().toLowerCase();
    const value = clean.slice(separatorIndex + 1).trim();

    if (key === "profile" || key === "name" || key === "profile_name") {
      parsed.profileName = value;
    } else if (key === "scheme" || key === "type" || key === "proxy_type") {
      parsed.proxyScheme = value;
    } else if (key === "host" || key === "proxy" || key === "proxy_host") {
      const parsedHostPort = splitHostAndPort(value);
      parsed.proxyHost = parsedHostPort.host;
      if (parsedHostPort.port && !hasExplicitPort) {
        parsed.proxyPort = parsedHostPort.port;
      }
    } else if (key === "port" || key === "proxy_port") {
      parsed.proxyPort = value;
      hasExplicitPort = true;
    } else if (key === "endpoint" || key === "server" || key === "proxy_endpoint") {
      const endpoint = parseEndpointHostPort(value);
      if (endpoint.host) {
        parsed.proxyHost = endpoint.host;
      }
      if (!hasExplicitPort && endpoint.port) {
        parsed.proxyPort = endpoint.port;
      }
    } else if (key === "bypass" || key === "bypass_list") {
      parsed.bypassList = value;
    }
  }

  return Object.keys(parsed).length ? normalizeProxyProfile(parsed) : null;
}

export function parseProxyConfig(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return normalizeProxyProfile({});
  }

  if (raw.startsWith("{")) {
    try {
      const json = JSON.parse(raw);
      return normalizeProxyProfile(json);
    } catch (_error) {
      // Continue with other parsers.
    }
  }

  const uriParsed = parseUri(raw);
  if (uriParsed) {
    return uriParsed;
  }

  const keyValueParsed = parseKeyValueConfig(raw);
  if (keyValueParsed) {
    return keyValueParsed;
  }

  if (!raw.includes("\n") && !raw.includes("\r")) {
    const endpointParsed = parseEndpointHostPort(raw);
    if (endpointParsed.host && !/\s/.test(endpointParsed.host)) {
      return normalizeProxyProfile({
        proxyHost: endpointParsed.host,
        proxyPort: endpointParsed.port
      });
    }
  }

  return normalizeProxyProfile({});
}

export function parseEndpointHostPort(endpoint) {
  const raw = normalizeText(endpoint);
  if (!raw) {
    return { host: "", port: DEFAULT_PROXY_PROFILE.proxyPort };
  }

  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      return {
        host: normalizeHost(url.hostname),
        port: parsedPortOrDefault(url.port)
      };
    } catch (_error) {
      // Continue with host:port parser.
    }
  }

  const parsed = splitHostAndPort(raw);

  return {
    host: parsed.host,
    port: parsedPortOrDefault(parsed.port)
  };
}

export function proxyMeta(profile) {
  const normalized = normalizeProxyProfile(profile);
  const host = normalized.proxyHost || "host-not-set";
  return `${normalized.proxyScheme.toUpperCase()} ${host}:${normalized.proxyPort}`;
}

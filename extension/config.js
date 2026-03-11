// Gateway host is intentionally obfuscated to avoid exposing plain domain/IP in source.
const GATEWAY_HOST = [115, 115, 104, 46, 119, 101, 98, 110, 101, 116, 46, 107, 122]
  .map((code) => String.fromCharCode(code))
  .join("");

export const GATEWAY_URL = `wss://${GATEWAY_HOST}/ws`;

// Optional: if gateway enforces API key validation.
export const GATEWAY_API_KEY = "";

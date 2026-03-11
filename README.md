# WireGuard Browser Proxy Extension

Chrome extension for browser-only proxy routing:
- SOCKS5 / HTTPS / HTTP profiles;
- profile import from file;
- one-click enable/disable from the main tab;
- single active profile rule (enabling one disables others);
- glowing green dot on extension icon when proxy is enabled.

## Project Structure

- `extension/` - Chrome extension (Manifest V3)

## Installation

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked` and select:
   - `/Users/mac/Desktop/WireGuard/extension`

No native host or external tools are required.

## Usage

### Main

- list of saved proxy profiles;
- state switch for each profile;
- when one profile is enabled, others are disabled automatically;
- if the selected host/port fails, extension auto-tries common proxy ports on the same host;
- `Import Proxy File` button imports and saves a profile.

### Settings

- select profile;
- create/delete profile;
- set proxy type (`SOCKS5`, `HTTPS`, `HTTP`);
- for a typical proxy server, use `HTTP`;
- use `HTTPS` only when your proxy server itself accepts TLS proxy connections;
- set host, port, bypass list;
- save profile settings.

## Import Formats

The import parser supports:
- URI form, for example: `socks5://proxy.example.com:1080`
- JSON object with profile fields
- key/value lines, for example:

```text
profile=office
scheme=socks5
host=proxy.example.com
port=1080
bypass=<local>,localhost,127.0.0.1
```

## Important

This extension changes traffic routing only inside Chrome.
It does not create a WireGuard tunnel and does not change system-wide network settings.

If your proxy requires authentication, configure credentials in Chrome proxy/auth flow.

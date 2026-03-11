# SSH Chrome Extension (Dark Material)

Расширение открывает отдельную вкладку `SSH` и подключается к SSH через **удаленный gateway**.

Это позволяет конечному пользователю просто установить расширение и подключаться, без локальной установки bridge.

## Структура

- `extension/` - Chrome extension (UI + WebSocket клиент).
- `bridge/` - SSH gateway (`WebSocket -> SSH`) для деплоя на сервер.

## Как это работает

1. Пользователь ставит расширение.
2. Расширение подключается к вашему `wss://.../ws` gateway.
3. Gateway поднимает SSH сессию к целевому хосту.

## Подготовка к публикации расширения

1. Разверните gateway (см. ниже).
2. В `extension/config.js` укажите ваш gateway:

```js
export const GATEWAY_URL = "wss://YOUR_GATEWAY_DOMAIN/ws";
export const GATEWAY_API_KEY = ""; // если используете ключ
```

3. Загрузите `extension/` в Chrome Web Store.

После этого пользователь просто ставит расширение и нажимает `Connect`.
Адрес gateway в интерфейсе расширения не показывается и не редактируется пользователем.

## Локальный запуск gateway (для разработки)

```bash
cd bridge
npm install
npm start
```

По умолчанию gateway слушает:

- HTTP health: `http://0.0.0.0:8787/health`
- WebSocket: `ws://0.0.0.0:8787/ws`

Для локальной разработки можно временно поставить в `extension/config.js`:

```js
export const GATEWAY_URL = "ws://127.0.0.1:8787/ws";
```

## Переменные окружения gateway

- `HTTP_HOST` (default: `0.0.0.0`)
- `HTTP_PORT` (default: `8787`)
- `WS_PATH` (default: `/ws`)
- `GATEWAY_API_KEY` (optional)
- `ALLOWED_ORIGINS` (CSV, optional)
- `SSH_HOST_ALLOWLIST` (CSV, optional)
- `MAX_CONNECTIONS_PER_IP` (default: `5`)

Пример:

```bash
HTTP_HOST=0.0.0.0 \
HTTP_PORT=8787 \
WS_PATH=/ws \
ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID \
SSH_HOST_ALLOWLIST=*.example.com,host1.example.com \
npm start
```

## Безопасность

- Секреты SSH (пароль/ключ) не сохраняются в `chrome.storage`.
- Для продакшена используйте `wss://` (TLS через reverse proxy).
- Рекомендуется выставить `ALLOWED_ORIGINS`, `SSH_HOST_ALLOWLIST`, и `GATEWAY_API_KEY`.

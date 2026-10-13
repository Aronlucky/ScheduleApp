# Облако для синхронизации планера

Сервер — один файл `worker.js` для Cloudflare Workers (бесплатный тариф, банковская карта не нужна).
Он хранит по одному **зашифрованному** блоку на аккаунт. Шифрование и расшифровка происходят только
на устройствах: сервер не видит ни ключей, ни дел, ни заметок, а только шифр и отпечаток пропуска.

## Как создать (≈10 минут, можно с телефона)

1. Зарегистрируйтесь на https://dash.cloudflare.com (почта и пароль).
2. **Хранилище.** Storage & Databases → KV → Create → имя `planner-data` → Create.
3. **Воркер.** Workers & Pages → Create → Worker («Hello World») → имя `planner-sync` → Deploy.
4. **Код.** Откройте воркер → Edit code → удалите всё и вставьте содержимое `server/worker.js` → Deploy.
5. **Привязка хранилища.** Воркер → Settings → Bindings → Add → KV namespace →
   Variable name: `DATA`, KV namespace: `planner-data` → Deploy.
6. **Настройки.** Воркер → Settings → Variables and Secrets → Add:
   - Type **Secret**, Name `ACCOUNTS`, Value — строка отпечатков, которую прислал Claude
     (отпечатки через запятую; это не сами ключи, по ним ключ не восстановить);
   - Type **Text**, Name `ALLOWED_ORIGINS`, Value `https://aronlucky.github.io` → Deploy.
7. Скопируйте адрес воркера вида `https://planner-sync.<ваше-имя>.workers.dev`.
   Проверка: откройте в браузере `<адрес>/v1/data` — должно показать `{"error":"unauthorized"}`.
8. Пришлите адрес — его нужно вписать в `index.html` (константа `SYNC_URL` и `connect-src` в
   Content-Security-Policy), после этого аккаунты по ключу заработают.

## Как добавить ещё один аккаунт

Новый ключ создаёт Claude (или любой криптостойкий генератор: 24 символа из
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`). В `ACCOUNTS` дописывается через запятую его отпечаток.
Чтобы отключить ключ — уберите его отпечаток из `ACCOUNTS`.

## Что видно владельцу облака

Только `acc:<отпечаток>` → `{ rev, data: "<шифр AES-256-GCM>", updated }`.
Без ключа шифр не расшифровать и не подделать: изменённые данные приложение отвергнет.

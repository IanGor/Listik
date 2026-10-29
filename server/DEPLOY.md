# Развёртывание сервера синхронизации Listik

Инструкция для агента (или человека) на сервере. Результат: по адресу вида
`https://sync.example.com` отвечает процесс `server/index.js` из этого
репозитория, за TLS‑прокси, с автозапуском и резервными копиями.

## Что это за сервер

- Один процесс Node.js (≥ 20) **без зависимостей**: `server/index.js`. Хранит данные в файлах каталога `LISTIK_DATA`, по каталогу на документ: журнал зашифрованных пачек операций `ops.jsonl`, последний зашифрованный снимок `snapshot.bin`, слот ключа `keyslot.json`, `meta.json`.
- **Сервер никогда не видит ни ключей, ни пароля, ни текста.** Шифрование сквозное, на устройствах (AES‑256‑GCM, ключ из пароля через Argon2id). Токен авторизации выводится из пароля на устройстве; сервер хранит только его SHA‑256. Скомпрометированный сервер может удалить или не отдать данные, но не прочитать; подмена записей ловится клиентом по цепочке хэшей.
- Поэтому резервные копии каталога данных можно хранить где угодно: это шифротекст.
- Нагрузка ничтожна: один пользователь, запросы по несколько килобайт, снимок до десятков мегабайт раз в несколько сотен правок.

## Входные данные, которые нужно знать заранее

| Параметр | Значение |
|---|---|
| Публичный адрес сервера | например `https://sync.example.com` (нужна DNS‑запись на этот хост) |
| Источник (origin) приложения | `https://iangor.github.io` — приложение раздаётся с GitHub Pages; добавить в `LISTIK_ORIGINS`. Если приложение будет открываться ещё откуда‑то, перечислить через запятую. Этот origin общий для всех проектов Pages аккаунта, и они видят хранилище Listik в браузере (§12 ARCHITECTURE): надёжнее свой домен для приложения, см. «Свой адрес для приложения» ниже |
| Пользователь ОС | `listik` (создаётся ниже) |
| Каталог данных | `/var/lib/listik` |

## Шаги

### 1. Node.js

```sh
node -v    # нужно v20 или новее
```

Если старше или нет: на Debian/Ubuntu — `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`; на других системах — пакет `nodejs` ≥ 20 из дистрибутива.

### 2. Код

```sh
useradd --system --home /var/lib/listik --shell /usr/sbin/nologin listik || true
install -d -o listik -g listik -m 750 /var/lib/listik
install -d -m 755 /opt/listik
git clone --depth 1 https://github.com/IanGor/Listik /opt/listik/src
cp /opt/listik/src/server/index.js /opt/listik/src/server/package.json /opt/listik/
```

Обновление впоследствии — автоматически из GitHub Actions (шаг 9) или вручную: `sudo /usr/local/sbin/listik-deploy` (то же самое, с откатом), без скрипта — `git -C /opt/listik/src pull && cp /opt/listik/src/server/index.js /opt/listik/ && systemctl restart listik-sync`.

### 3. Настройки

`/etc/listik/sync.env` (создать каталог `/etc/listik`, права `640`, владелец `root:listik`):

```sh
LISTIK_DATA=/var/lib/listik
LISTIK_HOST=127.0.0.1
LISTIK_PORT=8787
# Откуда браузер открывает приложение. Несколько — через запятую. Без завершающего слэша.
LISTIK_ORIGINS=https://iangor.github.io
# Сколько дней хранить пачки операций, уже вошедшие в снимок (устройство, не выходившее
# на связь дольше, загрузит документ заново со снимка).
LISTIK_RETENTION=30
# Принимать ли новые документы: только при значении 1 (без строки или с 0 — не принимает).
# Пока документ не создан — 1; после создания поставить 0 и перезапустить службу: тогда
# сервер обслуживает только уже существующие документы, а подключение новых устройств
# к ним по-прежнему работает (оно не создаёт документов).
LISTIK_ALLOW_CREATE=1
# Удаление документа целиком (DELETE) выключено; приложение им не пользуется.
# LISTIK_ALLOW_DELETE=1
```

Неудачные попытки авторизации и обращения к несуществующим документам сервер ограничивает: после 20 за 10 минут с одного адреса отвечает 429. Адрес — последний элемент `X-Forwarded-For`, который ставит прокси на этой же машине (Caddy делает это сам, nginx — строкой `proxy_set_header X-Forwarded-For $remote_addr`); от остальных заголовок не принимается, иначе клиент назначал бы себе любой адрес. Без этой строки в nginx все клиенты выглядят как один адрес `127.0.0.1`, и чужие ошибки блокируют и владельца.

### 4. systemd

`/etc/systemd/system/listik-sync.service`:

```ini
[Unit]
Description=Listik sync server
After=network-online.target
Wants=network-online.target

[Service]
User=listik
Group=listik
EnvironmentFile=/etc/listik/sync.env
WorkingDirectory=/opt/listik
ExecStart=/usr/bin/node /opt/listik/index.js
Restart=always
RestartSec=2
# Ужесточение: процессу нужен только каталог данных.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/listik
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now listik-sync
systemctl status listik-sync --no-pager
curl -s http://127.0.0.1:8787/health      # ожидается {"ok":true}
```

### 5. TLS и обратный прокси

**Caddy** (проще всего, сертификат Let's Encrypt получает сам). В `/etc/caddy/Caddyfile`:

```
sync.example.com {
    reverse_proxy 127.0.0.1:8787 {
        # Поток событий /docs/*/events держится открытым и шлёт строки по мере появления.
        flush_interval -1
        transport http {
            read_timeout 0
        }
    }
    request_body {
        max_size 300MB
    }
}
```

`systemctl reload caddy`.

**nginx**, если он уже стоит:

```nginx
server {
    listen 443 ssl http2;
    server_name sync.example.com;
    # ssl_certificate ... (certbot)
    client_max_body_size 300m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # адрес клиента для ограничения попыток
        proxy_buffering off;          # поток событий
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Если на сервере уже есть другой прокси (Traefik и т. п.), нужны те же три свойства: TLS, отключённая буферизация ответа, большой лимит тела запроса.

### 6. Проверка снаружи

```sh
curl -s https://sync.example.com/health
# {"ok":true}

curl -s -i -X OPTIONS https://sync.example.com/docs/testtesttest/ops \
  -H 'Origin: https://iangor.github.io' -H 'Access-Control-Request-Method: POST' | head -12
# В ответе должны быть Access-Control-Allow-Origin: https://iangor.github.io
# и Access-Control-Allow-Headers с Authorization.

curl -s -i https://sync.example.com/docs/testtesttest/ops | head -1
# HTTP/2 404 — документа нет, это правильно (без токена дальше не пускает).
```

### 7. Резервные копии

Данные — шифротекст, поэтому копию можно класть в любое хранилище. Ежедневно, например `/etc/cron.daily/listik-backup`:

```sh
#!/bin/sh
set -e
d=/var/backups/listik
mkdir -p "$d"
tar -C /var/lib -czf "$d/listik-$(date +%F).tgz" listik
find "$d" -name 'listik-*.tgz' -mtime +30 -delete
```

(`chmod +x`). Восстановление: остановить службу, распаковать в `/var/lib`, запустить.

### 8. Закрыть приём новых документов

Когда владелец создал свой документ из приложения (первое устройство, «Новый документ на сервере»), в `/etc/listik/sync.env` поставить `LISTIK_ALLOW_CREATE=0` и выполнить `systemctl restart listik-sync`. Проверка:

```sh
curl -s -X PUT https://sync.example.com/docs/probeprobeprobe/keyslot \
  -H 'Authorization: Bearer 0123456789abcdefghij' -d '{"keyslot":{"v":1}}'
# {"error":"this server does not accept new documents"}
```

Существующие документы и подключение к ним новых устройств продолжают работать. Если понадобится ещё один документ, временно вернуть 1. Без строки `LISTIK_ALLOW_CREATE` сервер (с октября 2026) тоже не принимает новых документов: открытым приём остаётся только при явной 1.

### 9. Автообновление из GitHub Actions

Workflow `.github/workflows/server.yml` при изменении `server/index.js` или `server/package.json` в `master` прогоняет тесты и заходит на сервер по SSH. Ключ принадлежит отдельному пользователю, который может запустить только скрипт обновления `server/deploy.sh`: подтянуть `master`, проверить синтаксис, заменить `index.js`, перезапустить службу и откатиться, если `/health` не ответил за 10 секунд.

```sh
# Скрипт — копия, владелец root: git pull его не меняет. После правки server/deploy.sh повторить.
install -o root -g root -m 755 /opt/listik/src/server/deploy.sh /usr/local/sbin/listik-deploy

# Пользователь без пароля; ключ в authorized_keys (владелец root) запускает только скрипт.
useradd --system --create-home --home-dir /var/lib/listik-deploy --shell /bin/sh listik-deploy
usermod -p '*' listik-deploy
install -d -o root -g root -m 755 /var/lib/listik-deploy/.ssh
echo 'restrict,command="sudo -n /usr/local/sbin/listik-deploy" ssh-ed25519 AAAA… github-actions' \
  > /var/lib/listik-deploy/.ssh/authorized_keys
echo 'listik-deploy ALL=(root) NOPASSWD: /usr/local/sbin/listik-deploy ""' > /etc/sudoers.d/listik-deploy
chmod 440 /etc/sudoers.d/listik-deploy && visudo -c

# Репозиторий публичный: тянуть по HTTPS, без ключа.
git -C /opt/listik/src remote set-url origin https://github.com/IanGor/Listik.git

# Если sshd ограничен AllowUsers — добавить пользователя, проверить и перечитать.
sshd -t && systemctl reload ssh
```

Секреты репозитория (Settings → Secrets and variables → Actions): `DEPLOY_SSH_KEY` — приватный ключ (ed25519, только для этого), `DEPLOY_KNOWN_HOSTS` — строка `[хост]:порт ssh-ed25519 …` из `/etc/ssh/ssh_host_ed25519_key.pub` сервера, `DEPLOY_HOST`, `DEPLOY_PORT`. Проверка: Actions → Server → Run workflow; в шаге Deploy будет `listik-deploy: <коммит> deployed` или `server code unchanged`.

Отозвать доступ: удалить строку из `/var/lib/listik-deploy/.ssh/authorized_keys` (или пользователя) и секрет `DEPLOY_SSH_KEY`.

### 10. Что сообщить обратно

1. Публичный адрес сервера (его вводят в приложении в поле «Сервер»).
2. Вывод `node -v`, `systemctl is-active listik-sync`, `curl -s https://…/health`.
3. Результат проверки CORS из шага 6.
4. Где лежат копии и как часто делаются.
5. Выполнен ли шаг 8 (приём новых документов закрыт).
6. Настроен ли шаг 9 и прошёл ли ручной запуск workflow Server.

## Если приложение решат раздавать с этого же сервера

Архитектурно код и данные разнесены нарочно: приложение приходит с GitHub Pages, данные лежат здесь, и взлом одного места не даёт подменить код и прочитать данные одновременно. Если всё же нужно раздавать сборку отсюда: собрать `npm ci && npm run build` в клоне репозитория, отдавать каталог `dist/` статикой (в Caddy — `file_server` в отдельном блоке с другим именем хоста) и добавить этот origin в `LISTIK_ORIGINS`.

## Свой адрес для приложения

Все проекты GitHub Pages одного аккаунта открываются с одного origin (`https://iangor.github.io/…`), а браузер делит хранилище (IndexedDB, localStorage) по origin, не по пути: скрипт соседнего проекта Pages может прочитать документ Listik в этом браузере и воспользоваться запомненным ключом. Чтобы у Listik было своё хранилище, нужен свой origin:

1. Поддомен своего домена для Pages, например `listik.example.com`: в DNS — запись `CNAME listik.example.com → iangor.github.io`; в настройках репозитория (Settings → Pages → Custom domain) — этот домен и «Enforce HTTPS». Тогда в `.github/workflows/pages.yml` сборка идёт с корня: `BASE: /` вместо `/Listik/`.
2. В `/etc/listik/sync.env` — новый origin в `LISTIK_ORIGINS` (через запятую со старым, пока устройства переезжают), `systemctl restart listik-sync`.
3. На каждом устройстве открыть новый адрес и «Подключиться к существующему» (код документа и пароль те же). На старом адресе сначала дождаться «Синхронизировано», чтобы ничего не осталось неотправленным; потом старый адрес можно забыть и убрать из `LISTIK_ORIGINS`.

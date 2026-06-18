# WhatsApp Personel Takip ve İletişim Paneli

Meta **WhatsApp Cloud API** tabanlı, çok kullanıcılı personel takip ve iletişim paneli.

## Özellikler

- Kullanıcı adı/şifre ile giriş, rol tabanlı yetki (admin, yönetici, denetçi, personel)
- Departman kapsamlı RBAC
- Cloud API üzerinden mesajlaşma (24 saat penceresi + şablon kuralları)
- Canlı sohbet, personel denetim, denetim günlüğü
- JSON (yerel) veya PostgreSQL (Railway) depolama + otomatik yedekleme
- Redis tabanlı rate limiting ve paylaşımlı webhook kuyruğu (yoksa bellek modu)
- Webhook imza doğrulama, idempotency ve dead-letter
- TOTP 2FA (API; arayüz ayrı eklenebilir)
- Postgres modunda mesaj/sohbet arama indeks tabloları

## Kurulum

```bash
npm start
```

Varsayılan adres: http://localhost:3000

**İlk admin:** Ortam değişkenleriyle oluşturulur (`ADMIN_USERNAME`, `ADMIN_PASSWORD`). Panel otomatik test kullanıcısı eklemez. Yerel sıfırlama: `node scripts/reset-panel-data.js`

## Ortam değişkenleri

| Değişken | Açıklama |
|----------|----------|
| `PORT` | Sunucu portu (varsayılan 3000) |
| `DATABASE_URL` | PostgreSQL bağlantısı (Railway; set edilirse kalıcı DB) |
| `REDIS_URL` | Redis bağlantısı (rate limit; opsiyonel) |
| `DATA_FILE` | JSON veri dosyası (DATABASE_URL yoksa) |
| `MEDIA_DIR` | Medya dosyaları (Railway volume önerilir) |
| `TRUST_PROXY` | Reverse proxy arkasında `1` (varsayılan kapalı) |
| `WEBHOOK_MAX_BYTES` | Webhook POST gövde sınırı (varsayılan 256 KB) |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Postgres SSL sertifika doğrulaması (`1` = sıkı) |
| `MAX_MEDIA_BYTES` | Medya yükleme üst sınırı (varsayılan 32 MB) |
| `SESSION_SECRET` | Oturum imzası (prod zorunlu) |
| `ADMIN_USERNAME` | İlk admin kullanıcı adı (prod zorunlu) |
| `ADMIN_PASSWORD` | İlk admin şifresi — min 8 karakter, büyük/küçük/rakam (prod zorunlu) |
| `ADMIN_FULL_NAME` | İlk admin görünen adı (opsiyonel) |
| `CLOUD_API_ACCESS_TOKEN` | Meta access token |
| `CLOUD_API_PHONE_NUMBER_ID` | Meta phone number id |
| `CLOUD_API_APP_SECRET` | Webhook imza doğrulama |
| `PERSIST_SECRETS_IN_STORE` | `0` ise token JSON'a yazılmaz (prod varsayılan `0`) |
| `CLOUD_API_GRAPH_VERSION` | Meta Graph API sürümü (varsayılan `v21.0`) |
| `REQUIRE_WEBHOOK_SIGNATURE` | `1` ise webhook imzası zorunlu |
| `AUDIT_LOG_MAX` | Saklanacak maksimum denetim kaydı |
| `MEDIA_MAX_AGE_DAYS` | Medya dosyası saklama süresi |
| `NODE_ENV=production` | Üretim güvenlik kontrolleri |

## Webhook

Meta Developer Console'da webhook URL:

```text
https://<domain>/webhook/whatsapp
```

## Railway dağıtımı

1. Railway'de yeni proje oluşturun, bu repoyu bağlayın.
2. **PostgreSQL** eklentisi ekleyin → `DATABASE_URL` otomatik gelir.
3. **Redis** eklentisi ekleyin (önerilir) → `REDIS_URL` otomatik gelir.
4. Ortam değişkenlerini ayarlayın (`railway.env.example`):
   - `SESSION_SECRET` (güçlü rastgele değer)
   - `ADMIN_USERNAME` ve `ADMIN_PASSWORD` (güçlü şifre; ilk deploy'da tek admin oluşur)
   - `NODE_ENV=production`
   - `TRUST_PROXY=1`
   - `MEDIA_DIR=/data/media` (volume mount ile)
5. Medya kalıcılığı için volume ekleyip `/data/media` yoluna bağlayın.
6. Deploy sonrası health: `https://<domain>/health`

`railway.toml` health check ve start komutunu içerir.

## Test

```bash
npm test
npm run smoke
npm run e2e:install
npm run e2e
```

## Roller

- **Admin:** Tam yetki, KVKK veri silme/dışa aktarma
- **Yönetici:** Kendi departmanı, personel denetim, Cloud API ayarları
- **Denetçi:** Departman personelini izleme ve mesajlaşma (personel denetim raporu yok)
- **Personel:** Kendi hesapları ve sohbetleri

## Veri

**Yerel (JSON):**
- Ana dosya: `data/app.json`
- Yedekler: `data/backups/`

**Railway (PostgreSQL):**
- `DATABASE_URL` ile tüm uygulama durumu `app_state` tablosunda
- Yedekler: `app_backups` tablosu
- Performans: `app_messages_index` ve `app_conversations_index` (otomatik senkron)

**Medya:** `MEDIA_DIR` (Railway'de volume kullanın)

PostgreSQL + Redis ile çoklu instance güvenlidir (webhook kuyruğu ve rate limit paylaşımlı). JSON modunda tek process çalıştırın.

## Health

`GET /health` yanıtında `rateLimitBackend` (`redis` / `memory`) ve `rateLimitDegraded` (Redis düşünce `true`) alanları bulunur.

## 2FA (API)

- `POST /api/auth/2fa/setup` — kurulum başlat
- `POST /api/auth/2fa/verify` — `{ "code": "123456" }` ile etkinleştir
- `POST /api/auth/2fa/disable` — `{ "password": "..." }` ile kapat
- Login: 2FA açık kullanıcılar için `{ "username", "password", "totpCode" }`
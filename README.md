# WhatsApp Personel Takip ve İletişim Paneli

Bu proje, çağrı merkezi personellerinin QR ile bir veya birden fazla WhatsApp oturumu bağlayabildiği, WhatsApp Web benzeri arayüzden müşteriyle iletişim kurabildiği, admin/yönetici/denetçi rollerinin departman bazlı takip ve raporlama yapabildiği kalıcı veri odaklı bir paneldir.

## Kapsam

- Kullanıcı adı/şifre ile giriş
- Admin, yönetici, denetçi ve personel rolleri
- Departman bazlı yetki kontrolü
- Personelin birden fazla WhatsApp hesabı eklemesi
- QR bekliyor / bağlı / bağlantı kesildi durumları
- WhatsApp Web benzeri sohbet ekranı
- Hazır şablon seçerek mesaj gönderme
- Manuel mesajlaşma
- Personelin mesaj silememesi
- Tüm mesajlaşmaların kalıcı olarak saklanması
- Admin/yönetici/denetçinin departman yetkisine göre personel sohbetlerine erişmesi
- Raporlama ve denetim kayıtları

## Önemli teknik not

Bu uygulama resmi Meta Business API kullanmaz. Mimari, QR tabanlı WhatsApp Web oturum sağlayıcısı bağlanacak şekilde tasarlanmıştır. Varsayılan çalışma modu `mock` sağlayıcıdır; bu sayede panel, yetkiler, sohbet, QR akışı, raporlar ve testler dış bağımlılık olmadan çalışır. Gerçek WhatsApp Web entegrasyonu için `src/whatsapp/baileysProvider.js` dosyasındaki sağlayıcı tamamlanmaya hazır adaptör olarak bırakılmıştır.

## Kurulum

```bash
npm install
npm start
```

Uygulama varsayılan olarak şu adreste açılır:

[http://localhost:3000](http://localhost:3000)

İlk admin bilgileri:

- Kullanıcı adı: `admin`
- Şifre: `admin123`

Ortam değişkenleriyle değiştirilebilir:

```bash
ADMIN_USERNAME=yonetici ADMIN_PASSWORD=guclu-sifre npm start
```

Windows PowerShell için:

```powershell
$env:ADMIN_USERNAME="yonetici"; $env:ADMIN_PASSWORD="guclu-sifre"; npm start
```

## Veri saklama

Varsayılan veri dosyası:

```text
data/app.json
```

Farklı dosya için:

```bash
DATA_FILE=/path/to/app.json npm start
```

## Roller

### Admin

- Tüm departmanları, kullanıcıları, WhatsApp hesaplarını, sohbetleri ve raporları görebilir
- Kullanıcı/departman/şablon yönetebilir
- Personel adına mesaj gönderebilir
- Mesajı panelde gizleyebilir; fiziksel kayıt silinmez

### Yönetici

- Sadece kendi departmanını yönetebilir
- Kendi departmanındaki personelleri ve mesajlaşmaları görebilir
- Kendi departmanı için kullanıcı ve şablon yönetebilir
- Kendi departmanı adına işlem ve mesaj gönderimi yapabilir

### Denetçi

- Hangi departmanda oluşturulduysa sadece o departmanın personellerini görebilir
- O departmanın WhatsApp hesaplarını, sohbetlerini ve mesajlarını takip edebilir
- Departman kapsamındaki sohbetlerde işlem sağlayabilir ve mesaj gönderebilir
- Kullanıcı, departman veya şablon yönetemez

### Personel

- Kendi WhatsApp hesaplarını ekleyebilir
- QR ile bağlantı başlatabilir
- Kendi hesaplarındaki sohbetleri görebilir
- Şablon seçip mesaj gönderebilir
- Manuel mesaj gönderebilir
- Mesaj silemez

## Test ve smoke

```bash
npm test
npm run smoke
```

## Canlı entegrasyon notları

Gerçek WhatsApp QR entegrasyonu için önerilen sıradaki çalışma:

1. `WHATSAPP_PROVIDER=baileys` modunu etkinleştirmek
2. `@whiskeysockets/baileys` paketini projeye eklemek
3. Oturum klasörünü kalıcı diske bağlamak
4. Sunucuda tekil process veya queue/worker mimarisiyle WhatsApp oturumlarını yönetmek
5. Yedekleme ve KV/DB kilitleme mekanizması eklemek

Bu temel panel bu entegrasyona hazır provider mimarisiyle oluşturulmuştur.
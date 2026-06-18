// Telefon numarası ve WhatsApp JID normalizasyonu.
// Proje varsayılan ülke kodu Türkiye (90) olarak ayarlıdır; DEFAULT_COUNTRY_CODE
// ortam değişkeniyle değiştirilebilir.

function defaultCountryCode() {
  return String(process.env.DEFAULT_COUNTRY_CODE || '90').replace(/\D/g, '') || '90';
}

// Ham telefon girdisini uluslararası biçimli rakam dizisine çevirir.
// NOT: `digits.length <= 10` sezgisi Türkiye numaraları (cc=90) için ayarlıdır;
// 10 haneli yerel numara varsayar. DEFAULT_COUNTRY_CODE farklı bir ülkeye
// ayarlanırsa, o ülkenin numara uzunluğuna göre bu eşik güvenilmez olabilir.
// Örnekler (cc=90):
//   "0505 110 32 97"   -> "905051103297"
//   "+90 505 110 3297" -> "905051103297"
//   "905051103297"     -> "905051103297"
//   "5051103297"       -> "905051103297"
function normalizePhone(raw, countryCode = defaultCountryCode()) {
  let digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) {
    digits = countryCode + digits.slice(1);
  } else if (digits.length <= 10) {
    // Ülke kodu olmadan girilmiş yerel numara
    digits = countryCode + digits;
  }
  return digits;
}

// WhatsApp bireysel sohbet JID'i üretir.
function toJid(raw, countryCode = defaultCountryCode()) {
  const digits = normalizePhone(raw, countryCode);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

// WhatsApp JID'inden görüntülenebilir telefon/kimlik değeri çıkarır.
function phoneFromJid(jid) {
  return String(jid || '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '')
    .replace(/:\d+$/, '')
    .split('@')[0];
}

module.exports = { normalizePhone, toJid, phoneFromJid, defaultCountryCode };

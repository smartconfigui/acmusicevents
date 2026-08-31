# Backend kurulumu (Google Apps Script + Sheets)

Toplam ~5 dakika. **`info@acmusicevents.com`'un bağlı olduğu Google hesabıyla yap**
— bilet mailleri o hesaptan gidecek.

## 1. Sheet'i oluştur
1. [sheets.new](https://sheets.new) → ad: `AC Music Events — Ticketing`

## 2. Script'i yapıştır
1. Menü: **Extensions → Apps Script**
2. Açılan editördeki her şeyi sil, `Code.gs` dosyasının içeriğini yapıştır, kaydet (⌘S).

## 3. Kurulumu çalıştır
1. Üstteki fonksiyon listesinden **`setup`** seç → **Run**.
2. İlk seferde yetki ister → hesabını seç → "Advanced → Go to … (unsafe)" → Allow.
   (Kendi yazdığın script olduğu için bu uyarı normal.)
3. `setup` şunları yapar: Events/Tiers/Orders sayfalarını kurar, YAZZ etkinliğini
   ve 3 kademeyi tohumlar (Early Bird 20/20 satıldı, GA 80, Final limitsiz),
   gizli anahtarları üretir, onay + süre aşımı tetikleyicilerini ekler.
4. **Execution log**'da `DOOR_KEY` yazar — kapı listesi linki için not al.

## 4. Web app olarak yayınla
1. Sağ üst: **Deploy → New deployment**
2. Tip: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
3. **Deploy** → çıkan **Web app URL**'ini kopyala (`https://script.google.com/macros/s/…/exec`)

## 5. Siteyi bağla
`index.html` içindeki `CONFIG.API_URL`'e bu URL'i yaz (ya da URL'i Claude'a ver).
Site o andan itibaren etkinlik/kontenjanları Sheet'ten okur ve siparişleri
Orders sayfasına `pending` olarak düşürür.

## Günlük kullanım

- **Onay:** Venmo'da ödemeyi gör → Orders'ta ilgili satırın `status` hücresini
  `confirmed` yap → QR'lı bilet maili otomatik gider (`confirmed_at` dolar).
- **Yeni etkinlik:** Events'e 1 satır + Tiers'a kademeleri ekle. Kod değişikliği yok.
- **Dışarıdan satış:** Tiers'ta `sold_elsewhere` sayısını artır — kontenjan düşer.
- **Kademe kapatma:** `cap`'i `sold_elsewhere`'e eşitle (kalan 0 olur).
- **Kapı listesi:** `WEB_APP_URL?action=door&key=DOOR_KEY` — isim ara, "Check in"e bas.
  Bilet QR'ı okutulunca çıkan sayfa durumu gösterir (✅ / ⚠️ zaten girdi / ⛔ geçersiz)
  ama işaretlemez; işaretleme kapı listesinden yapılır.
- **Süre aşımı:** 24 saatten eski `pending` siparişler otomatik `expired` olur,
  kontenjan geri açılır.

## Notlar

- Script'te değişiklik yaptıktan sonra **Deploy → Manage deployments → Edit →
  New version → Deploy** demeden canlıya yansımaz.
- Gizli anahtarlar (HMAC_KEY, DOOR_KEY) Script Properties'te durur; Sheet'te ve
  sitede görünmez.
- Gmail günlük mail kotası (consumer ~100/gün, Workspace daha yüksek) bu ölçek
  için fazlasıyla yeterli.

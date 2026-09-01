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
- **Kartla ödeme (Square, otomatik tam tutar):** bir kez kurulum —
  [developer.squareup.com](https://developer.squareup.com) → uygulama oluştur →
  **Production** sekmesinden Access Token'ı al; Location ID'yi Square Dashboard →
  Account & Settings → Locations'tan al. Apps Script → Project Settings →
  **Script Properties**'e ekle: `SQUARE_ACCESS_TOKEN` ve `SQUARE_LOCATION_ID`.
  O andan itibaren her siparişte site, tam tutarlı tek kullanımlık Square
  linki üretir ("Pay with card — $71.98"); ödeme notuna sipariş kodu otomatik
  düşer, onayı yine Orders'tan tick'lersin. Token yoksa kart butonu görünmez,
  Venmo akışı etkilenmez. (Square ücreti ~%2.9 + 30¢; yedek olarak Tiers'ın
  `square_link` kolonuna elle sabit link de koyulabilir.)
- **Gömülü kart formu (opsiyonel, önerilir):** Script Properties'e bir de
  `SQUARE_APP_ID` eklersen (developer.squareup.com'da token'ın hemen üstünde,
  `sq0idp-...` ile başlar) kart formu sitenin İÇİNDE açılır — alıcı siteden
  ayrılmaz, ödeme başarılı olunca sipariş OTOMATİK confirmed olur ve QR bilet
  maili anında gider (elle tick gerekmez). Bu property yoksa hazır Square
  sayfası linki kullanılmaya devam eder.
- **Kademe kapatma:** `cap`'i `sold_elsewhere`'e eşitle (kalan 0 olur).
- **Kapı / check-in:** `https://acmusicevents.com/checkin/` — şifre: `1453`
  (Code.gs'te `DOOR_PASS`; girildikten sonra o telefonda 4 saat geçerli).
  Sayfa içi kamerayla QR okutulur, geçerli bilet otomatik check-in olur
  (✅ isim + adet / ⚠️ zaten girdi / ⏳ ödeme onaysız / ⛔ geçersiz).
  "List" sekmesi etkinlik bazlı isim listesi: ara, tıkla, check-in.
  Misafir kendi QR linkini açarsa sadece bilet durumunu görür, işaretleyemez.
- **Venmo otomasyonu (V1.5):** 5 dakikada bir Gmail'deki Venmo makbuzları
  taranır ("X paid you $Y"); nottaki sipariş kodu + tutar eşleşirse sipariş
  otomatik `confirmed` olur ve QR bilet maili anında gider (notes kolonuna
  "venmo-otomatik" düşer). İşlenen mailler Gmail'de `acmusic-otomatik`
  etiketi alır; kodu okunamayan/eşleşmeyenler `acmusic-manuel-bak` etiketine
  düşer — arada bir o etikete bak, elle onayla. Tutar farklıysa otomatik
  onaylanmaz, fark Orders'ın notes kolonuna yazılır.
- **Süre aşımı:** 24 saatten eski `pending` siparişler otomatik `expired` olur,
  kontenjan geri açılır.

## Notlar

- Script'te değişiklik yaptıktan sonra **Deploy → Manage deployments → Edit →
  New version → Deploy** demeden canlıya yansımaz.
- Bilet QR imza anahtarı (HMAC_KEY) Script Properties'te durur; Sheet'te ve
  sitede görünmez. Kapı şifresi (`DOOR_PASS`) Code.gs'in başında tanımlı.
- Gmail günlük mail kotası (consumer ~100/gün, Workspace daha yüksek) bu ölçek
  için fazlasıyla yeterli.

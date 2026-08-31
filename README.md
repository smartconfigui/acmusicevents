# acmusicevents.com — site

`index.html` tek başına deploy edilir (Cloudflare Pages / herhangi bir statik host).
Dış bağımlılık yok: Tailwind CSS derlenmiş halde ve QR kütüphanesi
(qrcode-generator) dosyanın içine gömülü. Sadece Google Fonts dışarıdan gelir
(yüklenmezse fallback fontlara düşer).

## Ayarlar

`index.html` içindeki `CONFIG` bloğu:

- `API_URL` — Apps Script web app URL'i. Boşken site demo verilerle çalışır.
- `VENMO_HANDLE`, `CONTACT_EMAIL`, `INSTAGRAM`

## Tailwind CSS'i yeniden derleme

HTML'e yeni Tailwind class'ı eklenirse CSS yeniden derlenip
`<style id="tw">` bloğunun içeriği güncellenmelidir:

```sh
npm install tailwindcss@3
npx tailwindcss -c build/tailwind.config.js -i build/input.css -o /tmp/tw.css --minify
# /tmp/tw.css içeriğini index.html'deki <style id="tw">...</style> içine yapıştır
```

Renk/font token'ları `build/tailwind.config.js` içinde tanımlı.

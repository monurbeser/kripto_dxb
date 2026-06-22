# Kripto Sinyal Botu — Kurulum

Tek Vercel projesi: `index.html` (dashboard) + `api/scan.js` (tarama + Telegram) + `vercel.json` (günlük cron).

## Klasör yapısı
```
cryptobot/
├─ index.html        # dashboard (kendi /api/scan'ini çağırır)
├─ api/scan.js       # serverless fonksiyon: tarama + Telegram
├─ vercel.json       # cron (günde 1) + bölge fra1
└─ package.json
```

## 1) Telegram botu
1. Telegram'da **@BotFather** → `/newbot` → token al (ör. `123456:ABC...`).
2. Botu kendi sohbetinde başlat (`/start` yaz).
3. Chat ID için tarayıcıda aç:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Dönen JSON'da `"chat":{"id":...}` → bu senin `TELEGRAM_CHAT_ID`'in.
   (Grup için botu gruba ekle, grupta bir mesaj at, sonra aynı URL'den negatif id'yi al.)

## 2) Deploy (Vercel CLI)
```bash
npm i -g vercel
cd cryptobot
vercel            # ilk deploy (sorulara enter)
vercel --prod     # canlı
```
Ya da GitHub'a push edip Vercel'de "Import Project".

## 3) Environment Variables (Vercel → Settings → Environment Variables)
| Key | Değer |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_CHAT_ID` | getUpdates'ten aldığın id |
| `CRON_SECRET` | rastgele uzun string (cron/Telegram tetiğini korur) |

İsteğe bağlı ayarlar (default'lar parantezde):
`INTERVAL`(4h) · `TOP_N`(50) · `ADX_MIN`(20) · `SCORE_MIN`(3) ·
`MIN_QUOTE_VOLUME`(20000000) · `ATR_SL`(1.5) · `ATR_TP`(3.0) · `MAX_LEVERAGE`(10) · `RISK_PCT`(1.0)

Env değiştirince **redeploy** gerekir.

## 4) Cron (otomatik günlük Telegram)
`vercel.json` içindeki `"0 6 * * *"` her gün 06:00 UTC'de `/api/scan`'i tetikler.
Vercel, `CRON_SECRET` set'liyse isteğe otomatik `Authorization: Bearer <CRON_SECRET>` ekler →
fonksiyon bunu görünce Telegram'a yollar.

> **Vercel Hobby (ücretsiz) limiti:** cron günde 1 kez çalışır. Saatlik istiyorsan → Vercel Pro,
> ya da aşağıdaki GitHub Actions / Railway alternatifi.

## 5) Test
- Dashboard: deploy URL'ini aç → tablo dolmalı.
- Telegram'ı elle tetikle:
  `https://<proje>.vercel.app/api/scan?notify=1&secret=<CRON_SECRET>`
  → Telegram'a mesaj düşmeli, JSON'da `"notified":true` görünmeli.

## Önemli: Binance + bölge
`fapi.binance.com` **ABD IP'lerini engeller (HTTP 451)**. Vercel default bölgesi ABD'dir,
bu yüzden `vercel.json`'da `"regions":["fra1"]` (Frankfurt) ayarlı. Singapur için `sin1` yapabilirsin.
Bunu silme, yoksa cron 451 alır.

## Dashboard'ı ayrı yerde (Netlify) barındırmak istersen
`index.html`'i Netlify'a at, URL'ye fonksiyon adresini ekle:
`...netlify.app/?api=https://<proje>.vercel.app/api/scan`
(Fonksiyon CORS'a `*` döndürüyor, çalışır. Cron yine Vercel'de.)

---

## Alternatif: GitHub Actions (ücretsiz, saatlik olabilir)
Sunucu yerine zamanlı bir iş. `api/scan.js` mantığını bir CLI'a çevirip
`.github/workflows/scan.yml` içine `schedule: cron: "0 */4 * * *"` koyarsın, secret'ları
repo Secrets'a girersin. İstersen bu workflow'u da hazırlarım.

## Alternatif: Railway (zaten kullanıyorsun)
`node-cron` ile aynı tarama mantığını sürekli çalışan bir serviste döndürebilirsin —
saatlik/dakikalık esneklik için en rahatı. İstersen Railway versiyonunu da çıkarırım.

---

## Algoritma özeti (kendi konfluans skorun)
- **Trend:** fiyat > EMA50 (+1/−1)
- **Kısa trend:** EMA9 > EMA21 (+1/−1)
- **Momentum:** MACD histogram > 0 (+1/−1)
- **Yön gücü:** +DI > −DI (+1/−1)
- **RSI:** 50–72 arası (+1) / 28–50 arası (−1) — aşırı bölgede teyit
- **Filtre:** sadece `ADX ≥ ADX_MIN` iken ve `|skor| ≥ SCORE_MIN` iken sinyal
- **SL/TP:** ATR tabanlı (varsayılan 1.5 / 3.0 → ~1:2 R)
- **Kaldıraç:** SL mesafesi (ATR%) büyüdükçe düşer, `MAX_LEVERAGE` ile sınırlı

Eşikleri env'den oynayarak agresiflik/seçicilik dengesini ayarlarsın.

> ⚠️ Yatırım tavsiyesi değildir. Kaldıraçlı işlem yüksek risklidir; sinyalleri canlı paraya
> bağlamadan önce geçmiş veride (backtest) kendin doğrula.

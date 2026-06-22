// api/scan.js — Vercel Serverless Function (Node 18+, CommonJS)
// Binance USDT-M Futures public API ile en volatil N coini tarar,
// teknik göstergelere göre LONG/SHORT sinyali üretir, isteğe bağlı Telegram'a yollar.
// Auth gerektirmez (public market data). Telegram için CRON_SECRET ile koruma var.

const FAPI = "https://fapi.binance.com";

// ---- Ayarlar (Vercel env değişkenleriyle override edilebilir) ----
const CFG = {
  topN:            parseInt(process.env.TOP_N || "50", 10),
  interval:        process.env.INTERVAL || "4h",       // 15m,1h,4h,1d...
  klineLimit:      160,
  minQuoteVolume:  parseFloat(process.env.MIN_QUOTE_VOLUME || "20000000"), // likidite filtresi (USDT)
  adxMin:          parseFloat(process.env.ADX_MIN || "20"),  // trend gücü eşiği
  scoreMin:        parseInt(process.env.SCORE_MIN || "3", 10), // sinyal için min konfluans
  atrSL:           parseFloat(process.env.ATR_SL || "1.5"),  // SL = giriş ∓ 1.5*ATR
  atrTP:           parseFloat(process.env.ATR_TP || "3.0"),  // TP = giriş ± 3.0*ATR (≈1:2 RR)
  maxLeverage:     parseInt(process.env.MAX_LEVERAGE || "10", 10),
  riskPerTradePct: parseFloat(process.env.RISK_PCT || "1.0"), // kaldıraç önerisi için hedef
  concurrency:     8,
};

// ===================== Gösterge fonksiyonları =====================
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
  const validStart = macdLine.findIndex(v => v != null);
  const signalLine = new Array(closes.length).fill(null);
  if (validStart !== -1) {
    const sub = macdLine.slice(validStart).map(v => (v == null ? 0 : v));
    const sig = ema(sub, signal);
    for (let i = 0; i < sig.length; i++)
      if (sig[i] != null) signalLine[validStart + i] = sig[i];
  }
  const hist = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function atr(highs, lows, closes, period = 14) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  if (len <= period) return out;
  const tr = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    if (i === 0) { tr[i] = highs[i] - lows[i]; continue; }
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < len; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const empty = { adx: new Array(len).fill(null), plusDI: new Array(len).fill(null), minusDI: new Array(len).fill(null) };
  if (len < period * 3) return empty;
  const plusDM = new Array(len).fill(0), minusDM = new Array(len).fill(0), tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const wilder = (arr) => {
    const o = new Array(len).fill(null);
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += arr[i];
    o[period] = sum;
    for (let i = period + 1; i < len; i++) o[i] = o[i - 1] - o[i - 1] / period + arr[i];
    return o;
  };
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  const plusDI = new Array(len).fill(null), minusDI = new Array(len).fill(null), dx = new Array(len).fill(null);
  for (let i = period; i < len; i++) {
    if (trS[i]) {
      plusDI[i] = 100 * pS[i] / trS[i];
      minusDI[i] = 100 * mS[i] / trS[i];
      const s = plusDI[i] + minusDI[i];
      dx[i] = s === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / s;
    }
  }
  const adxArr = new Array(len).fill(null);
  let count = 0, sum = 0, start = null;
  for (let i = period + 1; i < len; i++) {
    if (dx[i] != null) {
      count++; sum += dx[i];
      if (count === period) { adxArr[i] = sum / period; start = i; break; }
    }
  }
  if (start != null)
    for (let i = start + 1; i < len; i++)
      if (dx[i] != null) adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
  return { adx: adxArr, plusDI, minusDI };
}

const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };

// ===================== Tarama mantığı =====================
async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "signal-bot/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Eş zamanlılık sınırlı map
async function pMap(items, fn, limit) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function analyzeSymbol(sym, kl, meta) {
  // kl: Binance klines dizisi [ openTime, open, high, low, close, volume, ... ]
  const highs = kl.map(c => +c[2]);
  const lows = kl.map(c => +c[3]);
  const closes = kl.map(c => +c[4]);
  if (closes.length < 60) return null;

  const ema9 = last(ema(closes, 9));
  const ema21 = last(ema(closes, 21));
  const ema50 = last(ema(closes, 50));
  const r = last(rsi(closes, 14));
  const m = macd(closes);
  const hist = last(m.hist);
  const a = atr(highs, lows, closes, 14);
  const atrVal = last(a);
  const ax = adx(highs, lows, closes, 14);
  const adxVal = last(ax.adx);
  const plusDI = last(ax.plusDI);
  const minusDI = last(ax.minusDI);
  const price = closes[closes.length - 1];

  if ([ema9, ema21, ema50, r, hist, atrVal, adxVal, plusDI, minusDI].some(v => v == null)) return null;

  // ---- Konfluans skoru (kendi algoritmamız) ----
  // Her koşul +1 (long) / -1 (short). |skor| büyükse sinyal güçlü.
  let score = 0;
  score += price > ema50 ? 1 : -1;            // ana trend filtresi
  score += ema9 > ema21 ? 1 : -1;             // kısa trend / kesişim
  score += hist > 0 ? 1 : -1;                 // MACD momentum
  score += plusDI > minusDI ? 1 : -1;         // yön gücü
  // RSI: aşırı bölgede ters yönde teyit ister
  if (r > 50 && r < 72) score += 1;
  else if (r < 50 && r > 28) score -= 1;

  const atrPct = (atrVal / price) * 100;
  let signal = "NEUTRAL";
  // Sadece trend yeterince güçlüyse ve skor eşiği aşılırsa sinyal ver
  if (adxVal >= CFG.adxMin) {
    if (score >= CFG.scoreMin) signal = "LONG";
    else if (score <= -CFG.scoreMin) signal = "SHORT";
  }

  // ATR tabanlı SL/TP
  let sl = null, tp = null;
  if (signal === "LONG") { sl = price - CFG.atrSL * atrVal; tp = price + CFG.atrTP * atrVal; }
  if (signal === "SHORT") { sl = price + CFG.atrSL * atrVal; tp = price - CFG.atrTP * atrVal; }

  // Kaldıraç önerisi: oynaklık (ATR%) arttıkça düşer. Konservatif.
  // hedef: SL'ye kadar olan hareket ~ riskPerTradePct * leverage olsun.
  const slDistPct = (CFG.atrSL * atrVal / price) * 100;
  let leverage = 1;
  if (slDistPct > 0) leverage = Math.max(1, Math.min(CFG.maxLeverage, Math.round((CFG.riskPerTradePct * 100) / slDistPct / 10)));

  return {
    symbol: sym,
    signal,
    score,
    strength: Math.abs(score),
    price,
    rsi: +r.toFixed(1),
    adx: +adxVal.toFixed(1),
    atrPct: +atrPct.toFixed(2),
    leverage,
    sl: sl != null ? +sl.toPrecision(5) : null,
    tp: tp != null ? +tp.toPrecision(5) : null,
    change24h: meta ? +(+meta.priceChangePercent).toFixed(2) : null,
    quoteVolume: meta ? Math.round(+meta.quoteVolume) : null,
  };
}

async function runScan(opts = {}) {
  const interval = opts.interval || CFG.interval;
  const topN = opts.topN || CFG.topN;
  // 1) Tüm 24s ticker -> en volatil N coini seç
  const tickers = await fetchJson(`${FAPI}/fapi/v1/ticker/24hr`);
  const universe = tickers
    .filter(t => t.symbol.endsWith("USDT") && !/UPUSDT$|DOWNUSDT$|BULLUSDT$|BEARUSDT$/.test(t.symbol))
    .filter(t => +t.quoteVolume >= CFG.minQuoteVolume)
    .map(t => ({ ...t, vol: Math.abs(+t.priceChangePercent) }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, topN);

  // 2) Her biri için klines çek + analiz et
  const results = await pMap(universe, async (t) => {
    const kl = await fetchJson(
      `${FAPI}/fapi/v1/klines?symbol=${t.symbol}&interval=${interval}&limit=${CFG.klineLimit}`
    );
    return analyzeSymbol(t.symbol, kl, t);
  }, CFG.concurrency);

  const rows = results.filter(Boolean);
  // Sinyaller önce, güçlüden zayıfa
  rows.sort((a, b) => {
    const sa = a.signal === "NEUTRAL" ? 0 : 1, sb = b.signal === "NEUTRAL" ? 0 : 1;
    if (sa !== sb) return sb - sa;
    return b.strength - a.strength || b.adx - a.adx;
  });
  return rows;
}

// ===================== Telegram =====================
function fmtMessage(actionable, interval) {
  const tf = interval || CFG.interval;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  let msg = `<b>📡 Kripto Sinyal Tarama</b>\n<i>${tf} • ${ts}</i>\n`;
  if (!actionable.length) { return msg + "\nŞu an eşikleri geçen sinyal yok."; }
  for (const s of actionable.slice(0, 12)) {
    const arrow = s.signal === "LONG" ? "🟢 LONG" : "🔴 SHORT";
    msg += `\n<b>${s.symbol}</b>  ${arrow}  (güç ${s.strength}/5)\n` +
      `Fiyat: ${s.price}  | 24s: ${s.change24h}%\n` +
      `RSI ${s.rsi} • ADX ${s.adx} • ATR ${s.atrPct}%\n` +
      `Kaldıraç ≈ ${s.leverage}x | SL ${s.sl} | TP ${s.tp}\n`;
  }
  msg += `\n⚠️ <i>Yatırım tavsiyesi değildir. Kaldıraçlı işlem yüksek risk taşır.</i>`;
  return msg;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "TELEGRAM env eksik" };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return await r.json();
}

// ===================== HTTP handler =====================
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // Telegram yetkisi: Vercel cron otomatik "Authorization: Bearer <CRON_SECRET>" ekler.
  const auth = req.headers["authorization"] || "";
  const q = req.query || {};
  const secretOk = process.env.CRON_SECRET &&
    (auth === `Bearer ${process.env.CRON_SECRET}` || q.secret === process.env.CRON_SECRET);
  const wantNotify = q.notify === "1" || auth.startsWith("Bearer ");
  const doNotify = wantNotify && secretOk;

  try {
    const interval = (typeof q.interval === "string" && q.interval) || CFG.interval;
    const topN = q.topN ? Math.min(80, parseInt(q.topN, 10) || CFG.topN) : CFG.topN;
    const rows = await runScan({ interval, topN });
    const actionable = rows.filter(r => r.signal !== "NEUTRAL");

    let telegram = null;
    if (doNotify) telegram = await sendTelegram(fmtMessage(actionable, interval));

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      config: { interval, topN, adxMin: CFG.adxMin, scoreMin: CFG.scoreMin },
      counts: { scanned: rows.length, signals: actionable.length },
      notified: doNotify,
      telegram,
      rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};

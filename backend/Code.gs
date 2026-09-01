/**
 * AC Music Events — Ticketing backend (Google Apps Script)
 *
 * Kurulum: backend/README.md
 * Sheet yapısı: Events, Tiers, Orders (setup() otomatik kurar)
 *
 * Uçlar (web app deploy sonrası):
 *   GET  ?action=events                     -> aktif etkinlikler + kademe kontenjanları (JSON)
 *   POST {action:'order', ...}              -> sipariş kaydı (pending) + referans kodu
 *   GET  ?action=status&code=X&email=Y      -> "biletim nerede?" sorgusu
 *   GET  ?action=scan&code=X&sig=Y          -> bilet QR doğrulama sayfası (işaretlemez)
 *   GET  ?action=door&key=DOOR_KEY          -> kapı listesi (isim ara + check-in)
 *   GET  ?action=checkin&key=K&order=N      -> siparişi checked_in yap
 *
 * Onay akışı: Orders sayfasında status hücresini "confirmed" yapınca
 * QR'lı bilet maili otomatik gider (kurulumda eklenen onEdit tetikleyicisi).
 * 24 saatten eski pending siparişler saatlik tetikleyiciyle "expired" olur.
 */

var TZ = 'America/Los_Angeles';
var PENDING_TTL_HOURS = 24;
var CHECKIN_URL = 'https://acmusicevents.com/checkin/'; // bilet QR'ının açtığı sayfa
var DOOR_PASS = '1453'; // kapı/check-in sayfası şifresi (statik)
var OVERSELL_MAX = 3;   // tek sipariş, kademe kalanının en fazla bu kadar üzerine çıkabilir

var EVENTS_HEADERS = ['event_id', 'title', 'date_time', 'venue', 'capacity', 'status', 'poster_url', 'ticket_url'];
var TIERS_HEADERS  = ['event_id', 'tier_id', 'tier_name', 'price', 'cap', 'sold_elsewhere', 'square_link'];
var ORDERS_HEADERS = ['order_id', 'created_at', 'event_id', 'tier_id', 'tier_name', 'name', 'email',
                      'qty', 'amount_due', 'ref_code', 'status', 'confirmed_at', 'checked_in_at', 'notes'];
var ORDER_STATUSES = ['pending', 'confirmed', 'checked_in', 'expired', 'cancelled'];

/* ============================== KURULUM ============================== */

/** Bir kez elle çalıştır: sayfaları kurar, YAZZ etkinliğini tohumlar,
 *  gizli anahtarları üretir, tetikleyicileri ekler. Tekrar çalıştırmak güvenlidir. */
function setup() {
  var ss = SpreadsheetApp.getActive();

  var events = ensureSheet_(ss, 'Events', EVENTS_HEADERS);
  var tiers  = ensureSheet_(ss, 'Tiers', TIERS_HEADERS);
  var orders = ensureSheet_(ss, 'Orders', ORDERS_HEADERS);

  // date_time kolonunu düz metin yap (Sheets'in tarihe çevirmesini engelle)
  events.getRange('C:C').setNumberFormat('@');

  // Orders.status için açılır menü
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(ORDER_STATUSES, true).build();
  orders.getRange(2, 11, orders.getMaxRows() - 1, 1).setDataValidation(rule);

  // YAZZ etkinliğini tohumla (Events boşsa)
  if (events.getLastRow() < 2) {
    events.appendRow(['sf-neck-sep19', 'YAZZ', '2026-09-19 20:00',
                      'Neck of the Woods · San Francisco', 100, 'active', '']);
    tiers.appendRow(['sf-neck-sep19', 'early', 'Early Bird',        30.33, 20, 20]);
    tiers.appendRow(['sf-neck-sep19', 'ga',    'General Admission', 35.99, 80, 0]);
    tiers.appendRow(['sf-neck-sep19', 'final', 'Final Presale',     47.32, '', 0]);
  }

  // Gizli anahtar (bir kez üretilir; bilet QR imzası için)
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('HMAC_KEY')) props.setProperty('HMAC_KEY', Utilities.getUuid() + Utilities.getUuid());

  // Tetikleyiciler (mükerrer kurulumu önle)
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  if (!have['onOrderEdit']) ScriptApp.newTrigger('onOrderEdit').forSpreadsheet(ss).onEdit().create();
  if (!have['expirePending']) ScriptApp.newTrigger('expirePending').timeBased().everyHours(1).create();
  if (!have['scanVenmo']) ScriptApp.newTrigger('scanVenmo').timeBased().everyMinutes(5).create();

  Logger.log('Kurulum tamam. Check-in sayfası: ' + CHECKIN_URL + ' (şifre: ' + DOOR_PASS + ')');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() < 1 || sh.getRange(1, 1).getValue() !== headers[0]) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ============================== HTTP UÇLARI ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var a = String(p.action || '').toLowerCase();
  try {
    if (a === 'events') {
      // 60 sn'lik cevap önbelleği: Sheet okumalarını atlayıp hızlı döner.
      var cache = CacheService.getScriptCache();
      var hit = cache.get('events_v1');
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
      var payload = JSON.stringify({ ok: true, card: cardReady_(), sq: sqPublic_(), events: getEvents_() });
      cache.put('events_v1', payload, 60);
      return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
    }
    if (a === 'status')  return json_(getStatus_(p.code, p.email));
    // JSON uçları — checkin sayfası (acmusicevents.com/checkin/) bunları kullanır
    if (a === 'verify')  return json_(verify_(p.code, p.sig));
    if (a === 'mark')    return json_(mark_(p.key, p.code, p.sig, p.order));
    if (a === 'list')    return json_(listOrders_(p.key));
    // Eski HTML görünümleri (yedek)
    if (a === 'scan')    return scanPage_(p.code, p.sig);
    if (a === 'door')    return doorPage_(p.key, p.q);
    if (a === 'checkin') return doorCheckin_(p.key, p.order);
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  try {
    if (String(body.action || '') === 'order') return json_(createOrder_(body));
    if (String(body.action || '') === 'pay')   return json_(payWithCard_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================== VERİ OKUMA ============================== */

function rows_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  return String(v);
}

/** Kademe başına kalan = cap - sold_elsewhere - (pending+confirmed+checked_in sipariş adetleri).
 *  cap boş = limitsiz (left: null). */
function tierLeftMap_() {
  var used = {}; // "event|tier" -> adet
  rows_('Orders').forEach(function (r) {
    var st = String(r[10]);
    if (st === 'pending' || st === 'confirmed' || st === 'checked_in') {
      var k = r[2] + '|' + r[3];
      used[k] = (used[k] || 0) + Number(r[7] || 0);
    }
  });
  var map = {};
  rows_('Tiers').forEach(function (r) {
    var k = r[0] + '|' + r[1];
    var cap = r[4];
    if (cap === '' || cap === null) { map[k] = null; return; } // limitsiz
    map[k] = Math.max(0, Number(cap) - Number(r[5] || 0) - (used[k] || 0));
  });
  return map;
}

function getEvents_() {
  var leftMap = tierLeftMap_();
  var tiersByEvent = {};
  rows_('Tiers').forEach(function (r) {
    (tiersByEvent[r[0]] = tiersByEvent[r[0]] || []).push({
      id: String(r[1]), name: String(r[2]), price: Number(r[3]),
      left: leftMap[r[0] + '|' + r[1]],
      square: String(r[6] || '').trim(), // Square Payment Link (doluysa kartla ödeme butonu çıkar)
    });
  });
  return rows_('Events')
    .filter(function (r) { return String(r[5]) === 'active'; })
    .map(function (r) {
      return {
        event_id: String(r[0]), title: String(r[1]), date_time: dateStr_(r[2]),
        venue: String(r[3]), capacity: Number(r[4] || 0),
        status: 'active', poster_url: String(r[6] || ''),
        ticket_url: String(r[7] || ''), // doluysa satış dış sitede: buton oraya link olur
        tiers: tiersByEvent[r[0]] || [],
      };
    });
}

/* ============================== SİPARİŞ ============================== */

function createOrder_(b) {
  var name = String(b.name || '').trim().slice(0, 80);
  var email = String(b.email || '').trim().slice(0, 120);
  var qty = Math.max(1, Math.min(8, parseInt(b.qty, 10) || 0));
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid name/email' };

  var ev = rows_('Events').filter(function (r) {
    return String(r[0]) === String(b.event_id) && String(r[5]) === 'active';
  })[0];
  if (!ev) return { ok: false, error: 'event not found' };

  var tier = rows_('Tiers').filter(function (r) {
    return String(r[0]) === String(b.event_id) && String(r[1]) === String(b.tier);
  })[0];
  if (!tier) return { ok: false, error: 'tier not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var left = tierLeftMap_()[b.event_id + '|' + b.tier];
    // Kademe tamamen kapanmadıysa, kalanın OVERSELL_MAX üzerine kadar satışa izin ver.
    if (left !== null && (left <= 0 || qty > left + OVERSELL_MAX)) {
      return { ok: false, error: 'sold_out', left: left };
    }

    var orders = SpreadsheetApp.getActive().getSheetByName('Orders');
    var n = orders.getLastRow(); // başlık dahil -> ilk sipariş no 101
    var prefix = String(ev[1]).replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'ACME';
    var ref = prefix + '-' + (100 + n);
    var amount = (qty * Number(tier[3])).toFixed(2);
    var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');

    orders.appendRow([n, now, String(b.event_id), String(tier[1]), String(tier[2]),
                      name, email, qty, amount, ref, 'pending', '', '', '']);
    CacheService.getScriptCache().remove('events_v1'); // kontenjan değişti, önbelleği tazele
    // Gömülü kart formu kuruluysa (APP_ID var) hosted yedek linki üretme — her siparişten ~1 sn kazandırır.
    var cardUrl = sqPublic_().app ? '' :
      squarePayLink_(ref, String(ev[1]) + ' — ' + qty + '× ' + String(tier[2]),
                     Math.round(qty * Number(tier[3]) * 100));
    return { ok: true, ref_code: ref, amount_due: amount, pay_card_url: cardUrl };
  } finally {
    lock.releaseLock();
  }
}

/** Sitedeki gömülü kart formu için gerekli AÇIK kimlikler (gizli değildir). */
function sqPublic_() {
  var p = PropertiesService.getScriptProperties();
  return { app: p.getProperty('SQUARE_APP_ID') || '', loc: p.getProperty('SQUARE_LOCATION_ID') || '' };
}

/** Gömülü kart formundan gelen token ile ödemeyi çeker; başarılıysa siparişi
 *  otomatik confirmed yapar ve QR bilet mailini hemen gönderir. */
function payWithCard_(b) {
  var found = findOrder_(b.ref_code);
  if (!found) return { ok: false, error: 'Order not found' };
  var st = String(found.row[10]);
  if (st === 'confirmed' || st === 'checked_in') return { ok: true, already: true };
  if (st !== 'pending') return { ok: false, error: 'Order is ' + st };

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SQUARE_ACCESS_TOKEN');
  var loc = props.getProperty('SQUARE_LOCATION_ID');
  if (!token || !loc) return { ok: false, error: 'Card payments not configured' };

  var resp = UrlFetchApp.fetch('https://connect.squareup.com/v2/payments', {
    method: 'post', contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Square-Version': '2024-06-04' },
    payload: JSON.stringify({
      source_id: String(b.token || ''),
      idempotency_key: String(found.row[9]) + '-' + Date.now(),
      amount_money: { amount: Math.round(Number(found.row[8]) * 100), currency: 'USD' },
      location_id: loc,
      note: String(found.row[9]) + ' — ' + String(found.row[5]),
      buyer_email_address: String(found.row[6]),
    }),
    muteHttpExceptions: true,
  });
  var data = JSON.parse(resp.getContentText());
  if (data.payment && (data.payment.status === 'COMPLETED' || data.payment.status === 'APPROVED')) {
    var sh = SpreadsheetApp.getActive().getSheetByName('Orders');
    var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    sh.getRange(found.sheetRow, 11).setValue('confirmed');
    sh.getRange(found.sheetRow, 12).setValue(now);
    var rowData = sh.getRange(found.sheetRow, 1, 1, ORDERS_HEADERS.length).getValues()[0];
    try { sendTicket_(rowData); } catch (e) { Logger.log('bilet maili gönderilemedi: ' + e); }
    CacheService.getScriptCache().remove('events_v1');
    return { ok: true };
  }
  Logger.log('Square payment cevabı: ' + resp.getContentText());
  var err = (data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code)) || 'Payment failed';
  return { ok: false, error: err };
}

/** Square kurulu mu? (Sitede "Pay with Card" butonunun görünmesini belirler.) */
function cardReady_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('SQUARE_ACCESS_TOKEN') && p.getProperty('SQUARE_LOCATION_ID'));
}

/** Sipariş tutarı kadar tek kullanımlık Square ödeme linki üretir.
 *  Script Properties'te SQUARE_ACCESS_TOKEN ve SQUARE_LOCATION_ID yoksa '' döner
 *  (site o zaman kart butonu göstermez; Venmo akışı etkilenmez). */
function squarePayLink_(ref, desc, amountCents) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SQUARE_ACCESS_TOKEN');
  var loc = props.getProperty('SQUARE_LOCATION_ID');
  if (!token || !loc || !(amountCents > 0)) return '';
  try {
    var resp = UrlFetchApp.fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token, 'Square-Version': '2024-06-04' },
      payload: JSON.stringify({
        idempotency_key: ref + '-' + Date.now(),
        quick_pay: {
          name: desc + ' (' + ref + ')',
          price_money: { amount: amountCents, currency: 'USD' },
          location_id: loc,
        },
        payment_note: ref, // ödeme kaydına sipariş kodu düşer -> eşleştirme
        checkout_options: { redirect_url: 'https://acmusicevents.com/?paid=1' },
      }),
      muteHttpExceptions: true,
    });
    var data = JSON.parse(resp.getContentText());
    var url = (data.payment_link && data.payment_link.url) || '';
    if (!url) Logger.log('Square cevabı: ' + resp.getContentText());
    return url;
  } catch (e) {
    Logger.log('Square hatası: ' + e);
    return ''; // Square hata verirse kartsız devam, sipariş etkilenmez
  }
}

/** Editörden Run et: Square kurulumunu test eder.
 *  İlk çalıştırmada "dış servise bağlanma" izni ister — Allow de.
 *  Log'da bir square.link URL'i görüyorsan kurulum tamam demektir. */
function testSquare() {
  var url = squarePayLink_('TEST-' + Date.now(), 'Kurulum testi — 1× bilet', 100);
  Logger.log(url ? ('ÇALIŞIYOR ✓ ' + url) : 'BAŞARISIZ — yukarıdaki Square cevabına bak (token/location?)');
}

function getStatus_(code, email) {
  var r = findOrder_(code);
  if (!r || String(r.row[6]).toLowerCase() !== String(email || '').trim().toLowerCase()) {
    return { ok: false, error: 'not found' };
  }
  return { ok: true, status: String(r.row[10]), qty: Number(r.row[7]),
           tier_name: String(r.row[4]), event_id: String(r.row[2]) };
}

function findOrder_(refCode) {
  var all = rows_('Orders');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i][9]) === String(refCode || '').trim().toUpperCase()) {
      return { row: all[i], sheetRow: i + 2 };
    }
  }
  return null;
}

/* ============================== ONAY & BİLET MAİLİ ============================== */

/** Kurulumun eklediği installable onEdit tetikleyicisi. */
function onOrderEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== 'Orders' || e.range.getColumn() !== 11) return; // K = status
  var row = e.range.getRow();
  if (row < 2 || String(e.range.getValue()) !== 'confirmed') return;

  var data = sh.getRange(row, 1, 1, ORDERS_HEADERS.length).getValues()[0];
  if (data[11]) return; // confirmed_at doluysa mail zaten gitti
  sendTicket_(data);
  sh.getRange(row, 12).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'));
}

function hmac_(text) {
  var key = PropertiesService.getScriptProperties().getProperty('HMAC_KEY');
  var raw = Utilities.computeHmacSha256Signature(text, key);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('').slice(0, 16);
}

function sendTicket_(o) {
  var ev = rows_('Events').filter(function (r) { return String(r[0]) === String(o[2]); })[0] || [];
  var code = String(o[9]);
  var sig = hmac_(code);
  // QR kendi domain'imizi açar — Google hesap bağlamına girmez
  var scanUrl = CHECKIN_URL + '?c=' + encodeURIComponent(code + '.' + sig);
  var qrImg = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(scanUrl);

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1B2033">' +
    '<h2 style="margin:0 0 4px">🎟️ ' + esc_(String(ev[1] || '')) + '</h2>' +
    '<p style="margin:0 0 16px;color:#5B6377">' + esc_(dateStr_(ev[2])) + ' — ' + esc_(String(ev[3] || '')) + '</p>' +
    '<table style="border:1px solid #DDE1EE;border-collapse:collapse;width:100%">' +
    trow_('Name', o[5]) + trow_('Tickets', o[7] + ' × ' + o[4]) +
    trow_('Paid', '$' + o[8]) + trow_('Code', code) +
    '</table>' +
    '<p style="text-align:center;margin:20px 0"><img src="' + qrImg + '" width="280" height="280" alt="Ticket QR"></p>' +
    '<p style="color:#5B6377">Show this QR (or your name) at the door. See you there!</p>' +
    '</div>';

  MailApp.sendEmail({
    to: String(o[6]),
    subject: 'Your tickets — ' + ev[1] + ' · ' + dateStr_(ev[2]),
    htmlBody: html,
    name: 'AC Music Events',
  });
}

function trow_(k, v) {
  return '<tr><td style="padding:8px 12px;border:1px solid #DDE1EE;color:#5B6377">' + esc_(String(k)) +
         '</td><td style="padding:8px 12px;border:1px solid #DDE1EE;font-weight:bold">' + esc_(String(v)) + '</td></tr>';
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ============================== VENMO OTOMASYONU (V1.5) ============================== */

var LBL_AUTO = 'acmusic-otomatik';      // otomatik onaylanan makbuzlar
var LBL_MANUAL = 'acmusic-manuel-bak';  // kod/eşleşme bulunamayanlar — elle bak

/** 5 dakikada bir çalışır (kurulumdaki tetikleyici): Gmail'deki Venmo
 *  makbuzlarını tarar, nottaki sipariş kodunu ve tutarı çıkarır, eşleşen
 *  pending siparişi confirmed yapıp QR bilet mailini gönderir. */
function scanVenmo() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var q = 'from:venmo@venmo.com subject:"paid you" newer_than:7d' +
            ' -label:' + LBL_AUTO + ' -label:' + LBL_MANUAL;
    var threads = GmailApp.search(q, 0, 20);
    if (!threads.length) return;
    var lblAuto = getOrCreateLabel_(LBL_AUTO);
    var lblManual = getOrCreateLabel_(LBL_MANUAL);
    var sh = SpreadsheetApp.getActive().getSheetByName('Orders');
    var handledAny = false;

    threads.forEach(function (th) {
      var handled = false;
      var msgs = th.getMessages();
      for (var i = 0; i < msgs.length && !handled; i++) {
        var text = msgs[i].getSubject() + '\n' + msgs[i].getPlainBody().slice(0, 3000);
        var code = (text.match(/\b([A-Z]{2,6}-\d{3,5})\b/) || [])[1];
        if (!code) continue;
        var found = findOrder_(code);
        if (!found) continue;
        var st = String(found.row[10]);
        if (st === 'confirmed' || st === 'checked_in') { handled = true; continue; } // zaten onaylı
        if (st !== 'pending') continue;

        var amt = (text.match(/\$\s?([0-9,]+\.\d{2})/) || [])[1];
        var due = Number(found.row[8]).toFixed(2);
        if (amt && Number(amt.replace(/,/g, '')).toFixed(2) !== due) {
          // Tutar tutmuyor: otomatik onaylama, nota düş, elle bakılsın.
          sh.getRange(found.sheetRow, 14).setValue('Venmo tutarı farklı: $' + amt + ' (beklenen $' + due + ')');
          continue;
        }
        var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
        sh.getRange(found.sheetRow, 11).setValue('confirmed');
        sh.getRange(found.sheetRow, 12).setValue(now);
        sh.getRange(found.sheetRow, 14).setValue('venmo-otomatik');
        var rowData = sh.getRange(found.sheetRow, 1, 1, ORDERS_HEADERS.length).getValues()[0];
        try { sendTicket_(rowData); } catch (e) { Logger.log('bilet maili gönderilemedi: ' + e); }
        handled = true;
        handledAny = true;
      }
      th.addLabel(handled ? lblAuto : lblManual);
    });
    if (handledAny) CacheService.getScriptCache().remove('events_v1');
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/* ============================== SÜRE AŞIMI ============================== */

function expirePending() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Orders');
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = Date.now() - PENDING_TTL_HOURS * 3600 * 1000;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, ORDERS_HEADERS.length).getValues();
  data.forEach(function (r, i) {
    if (String(r[10]) === 'pending' && new Date(String(r[1]).replace(' ', 'T')).getTime() < cutoff) {
      sh.getRange(i + 2, 11).setValue('expired');
    }
  });
}

/* ============================== KAPI GÖRÜNÜMÜ ============================== */

function doorOk_(key) {
  return key && String(key) === DOOR_PASS;
}

function orderInfo_(r) {
  return { ok: true, status: String(r[10]), name: String(r[5]), qty: Number(r[7]),
           tier_name: String(r[4]), code: String(r[9]), checked_in_at: String(r[12] || '') };
}

/** Bilet doğrulama (işaretlemez). code + hmac imzası gerekir. */
function verify_(code, sig) {
  if (!code || !sig || hmac_(String(code).trim().toUpperCase()) !== String(sig)) {
    return { ok: false, error: 'invalid' };
  }
  var o = findOrder_(code);
  if (!o) return { ok: false, error: 'not_found' };
  return orderInfo_(o.row);
}

/** Check-in işareti. key şart; bilet ya code+sig ile ya da order id ile bulunur.
 *  result: checked_in | already | not_confirmed */
function mark_(key, code, sig, orderId) {
  if (!doorOk_(key)) return { ok: false, error: 'denied' };
  var found = null;
  if (orderId) {
    var data = rows_('Orders');
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(orderId)) { found = { row: data[i], sheetRow: i + 2 }; break; }
    }
  } else {
    if (!code || !sig || hmac_(String(code).trim().toUpperCase()) !== String(sig)) {
      return { ok: false, error: 'invalid' };
    }
    found = findOrder_(code);
  }
  if (!found) return { ok: false, error: 'not_found' };

  var info = orderInfo_(found.row);
  var st = String(found.row[10]);
  if (st === 'checked_in') { info.result = 'already'; return info; }
  if (st !== 'confirmed')  { info.result = 'not_confirmed'; return info; }

  var sh = SpreadsheetApp.getActive().getSheetByName('Orders');
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  sh.getRange(found.sheetRow, 11).setValue('checked_in');
  sh.getRange(found.sheetRow, 13).setValue(now);
  info.status = 'checked_in'; info.checked_in_at = now; info.result = 'checked_in';
  return info;
}

/** Kapı listesi verisi (confirmed + checked_in), etkinlik adıyla birlikte. */
function listOrders_(key) {
  if (!doorOk_(key)) return { ok: false, error: 'denied' };
  var titles = {};
  rows_('Events').forEach(function (r) {
    titles[String(r[0])] = String(r[1]) + ' · ' + dateStr_(r[2]).slice(0, 10);
  });
  var orders = rows_('Orders')
    .filter(function (r) { var s = String(r[10]); return s === 'confirmed' || s === 'checked_in'; })
    .map(function (r) {
      return { order_id: r[0], event: titles[String(r[2])] || String(r[2]),
               name: String(r[5]), qty: Number(r[7]), tier_name: String(r[4]),
               code: String(r[9]), status: String(r[10]), checked_in_at: String(r[12] || '') };
    });
  return { ok: true, orders: orders };
}

function scanPage_(code, sig) {
  var valid = code && sig && hmac_(String(code)) === String(sig);
  var o = valid ? findOrder_(code) : null;
  var st = o ? String(o.row[10]) : '';
  var color = '#B3261E', icon = '⛔', msg = 'Invalid ticket';
  if (o && st === 'confirmed')      { color = '#1C8A4C'; icon = '✅'; msg = o.row[7] + ' ticket(s) — ' + o.row[5]; }
  else if (o && st === 'checked_in'){ color = '#8A5A00'; icon = '⚠️'; msg = 'Already checked in (' + o.row[12] + ')'; }
  else if (o && st === 'pending')   { color = '#8A5A00'; icon = '⚠️'; msg = 'Payment not confirmed yet'; }
  else if (o)                       { msg = 'Ticket ' + st; }
  return HtmlService.createHtmlOutput(
    '<body style="font-family:Arial;background:#0E1120;color:#fff;text-align:center;padding:60px 20px">' +
    '<div style="font-size:72px">' + icon + '</div>' +
    '<h2 style="color:' + color + '">' + esc_(msg) + '</h2>' +
    (o ? '<p style="color:#9AA1BD">' + esc_(String(o.row[9])) + ' · ' + esc_(String(o.row[4])) + '</p>' : '') +
    '</body>').setTitle('Ticket check');
}

function doorPage_(key, q) {
  if (!doorOk_(key)) return HtmlService.createHtmlOutput('<h3>Access denied</h3>');
  var base = ScriptApp.getService().getUrl();
  var query = String(q || '').toLowerCase();
  var rowsHtml = rows_('Orders')
    .filter(function (r) {
      var st = String(r[10]);
      if (st !== 'confirmed' && st !== 'checked_in') return false;
      return !query || String(r[5]).toLowerCase().indexOf(query) >= 0 ||
             String(r[9]).toLowerCase().indexOf(query) >= 0;
    })
    .map(function (r) {
      var inYet = String(r[10]) === 'checked_in';
      return '<tr>' +
        '<td style="padding:10px;border-bottom:1px solid #2A3050">' + esc_(String(r[5])) +
        '<br><span style="color:#9AA1BD;font-size:12px">' + esc_(String(r[9])) + ' · ' + r[7] + ' × ' + esc_(String(r[4])) + '</span></td>' +
        '<td style="padding:10px;border-bottom:1px solid #2A3050;text-align:right">' +
        (inYet
          ? '<span style="color:#8A5A00">✔ girdi ' + esc_(String(r[12]).slice(11, 16)) + '</span>'
          : '<a style="background:#5B6CFF;color:#fff;padding:8px 14px;text-decoration:none;border-radius:6px" href="' +
            base + '?action=checkin&key=' + encodeURIComponent(key) + '&order=' + r[0] + '">Check in</a>') +
        '</td></tr>';
    }).join('');
  return HtmlService.createHtmlOutput(
    '<body style="font-family:Arial;background:#0E1120;color:#fff;margin:0;padding:16px">' +
    '<h2 style="margin:4px 0 12px">🚪 Door list</h2>' +
    '<form method="get" action="' + base + '" style="margin-bottom:12px">' +
    '<input type="hidden" name="action" value="door"><input type="hidden" name="key" value="' + esc_(key) + '">' +
    '<input name="q" value="' + esc_(String(q || '')) + '" placeholder="İsim veya kod ara" ' +
    'style="width:70%;padding:10px;border-radius:6px;border:1px solid #2A3050;background:#161A2E;color:#fff">' +
    '<button style="padding:10px 16px;border-radius:6px;border:0;background:#5B6CFF;color:#fff">Ara</button></form>' +
    '<table style="width:100%;border-collapse:collapse">' + (rowsHtml || '<tr><td style="color:#9AA1BD;padding:10px">Kayıt yok</td></tr>') + '</table>' +
    '</body>').setTitle('Door list');
}

function doorCheckin_(key, orderId) {
  if (!doorOk_(key)) return HtmlService.createHtmlOutput('<h3>Access denied</h3>');
  var sh = SpreadsheetApp.getActive().getSheetByName('Orders');
  var data = rows_('Orders');
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(orderId)) {
      if (String(data[i][10]) === 'confirmed') {
        sh.getRange(i + 2, 11).setValue('checked_in');
        sh.getRange(i + 2, 13).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'));
      }
      break;
    }
  }
  // listeye geri dön
  var base = ScriptApp.getService().getUrl();
  return HtmlService.createHtmlOutput(
    '<script>window.top.location="' + base + '?action=door&key=' + encodeURIComponent(key) + '";</script>' +
    '<a href="' + base + '?action=door&key=' + encodeURIComponent(key) + '">Listeye dön</a>');
}

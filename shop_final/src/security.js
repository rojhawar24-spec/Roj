import crypto from 'node:crypto';

export function csrfToken(req, res, next) {
  res.locals.csrf = req.session.csrf;
  next();
}

export function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session.csrf;
  if (!token || !expected) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your security token is missing or invalid. Refresh the page and try again.'
    });
  }
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your security token is missing or invalid. Refresh the page and try again.'
    });
  }
  next();
}

export const cleanText = (value, max = 5000) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()
  .slice(0, max);

export const validId = value => Number.isInteger(Number(value)) && Number(value) > 0;

export const moneyCents = value => {
  const normalized = String(value ?? '').replace(',', '.').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
};

export const safeDateOrNull = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};


export function formatDateTimeDisplay(value, timeZone='Europe/Brussels') {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch { return ''; }
}

export function formatDateTimeLocal(value, timeZone='Europe/Brussels') {
  if (!value) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
    }).formatToParts(new Date(value)).reduce((acc,p)=>{ if(p.type!=='literal') acc[p.type]=p.value; return acc; }, {});
    if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) return '';
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch { return ''; }
}

function timezoneOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(instantMs)).reduce((acc,p)=>{ if(p.type!=='literal') acc[p.type]=p.value; return acc; }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - instantMs;
}

export function dateTimeLocalToISOString(value, timeZone='Europe/Brussels') {
  const raw=String(value||'').trim();
  const match=raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [,y,mo,d,h,mi]=match;
  const year=Number(y), month=Number(mo), day=Number(d), hour=Number(h), minute=Number(mi);
  if (month<1||month>12||day<1||day>31||hour>23||minute>59) return null;
  try {
    const wallMs=Date.UTC(year,month-1,day,hour,minute,0,0);

    // Reject impossible calendar dates like 2026-02-31 or 2026-04-31.
    // JavaScript Date silently rolls these into the next month, so we
    // verify that the wall-clock parts round-trip unchanged before
    // applying the timezone conversion.
    const calendarCheck = new Date(wallMs);
    if (
      calendarCheck.getUTCFullYear() !== year ||
      calendarCheck.getUTCMonth() !== month - 1 ||
      calendarCheck.getUTCDate() !== day ||
      calendarCheck.getUTCHours() !== hour ||
      calendarCheck.getUTCMinutes() !== minute
    ) {
      return null;
    }

    let offset=timezoneOffsetMs(wallMs,timeZone);
    let instantMs=wallMs-offset;
    const corrected=timezoneOffsetMs(instantMs,timeZone);
    if (corrected!==offset) instantMs=wallMs-corrected;
    const dte=new Date(instantMs);
    if(Number.isNaN(dte.getTime())) return null;
    return dte.toISOString();
  } catch { return null; }
}

function noProtocolRelative(value) {
  return !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value);
}

export const isSafeUrl = value => {
  if (!value) return true;
  const s = String(value).trim();
  if (s.startsWith('/')) return noProtocolRelative(s);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
};

export const isSafeLocalPath = value => {
  const s = String(value ?? '');
  return Boolean(s) && s.startsWith('/') && noProtocolRelative(s);
};

export function assertUploadSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export const STRIPE_TWO_DECIMAL_CURRENCIES = Object.freeze(['EUR','USD','GBP','CHF','CAD','AUD','NZD','SEK','NOK','DKK','PLN','CZK','RON']);
export const isValidCurrency = value => {
  const code = String(value ?? '').toUpperCase();
  if (!STRIPE_TWO_DECIMAL_CURRENCIES.includes(code)) return false;
  try {
    new Intl.NumberFormat('en-GB', { style:'currency', currency:code }).format(1);
    return true;
  } catch {
    return false;
  }
};

export const isStrongEnoughPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 200;

// =========================================================
// Phone validation
// Supports international formats:
//   +964 750 123 4567   (Iraq / Kurdistan)
//   0750 123 4567       (local)
//   +31 6 12345678      (Netherlands)
//   +1 (555) 123-4567   (USA)
// Requires 7-20 actual digits. Rejects strings like "-------".
// =========================================================
export function isValidPhone(value) {
  const s = String(value ?? '').trim();

  if (s.length === 0 || s.length > 32) return false;

  // Only allow: optional leading +, digits, spaces, parentheses, dashes
  if (!/^\+?[0-9 ()-]+$/.test(s)) return false;

  // Count actual digits
  const digits = (s.match(/\d/g) || []).length;

  return digits >= 7 && digits <= 20;
}
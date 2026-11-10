// @ts-check

/*
 * Default-deny scrubbing. A string is KEPT only when it is provably structural (an ID, a short number, an ISO date,
 * a short lowercase code under a key that is not sensitive); everything else is replaced with a stable fake derived
 * from HMAC-SHA256(salt, value) that keeps the value's form (email, URL, date, digits, phone, text).
 *
 * ponytail: residual risk, a short lowercase personal value under an unknown key is kept (a handle such as "jdoe" or
 * a name such as "maria" under "who"), as is any JSON number under an unknown key (a phone stored as a number) and an
 * ISO date under an unknown key (a birth date under "born"). Object keys that look like identifiers are kept, so a
 * map keyed by lowercase handles leaks them. Audit a sample of captured cases by hand before production use, and add
 * the project's own field names to `redactKeys`.
 */

const enc = new TextEncoder();

/** Matched as substrings of the key with separators removed and lowercased ("API_Key" -> "apikey"). */
export const SENSITIVE_SUBSTRINGS = [
  "password", "passwd", "passphrase", "secret", "token", "auth", "cookie", "session", "apikey", "accesskey",
  "privatekey", "credential", "signature", "creditcard", "cardnumber", "cardholder", "cvv", "cvc", "iban",
  "accountnumber", "routingnumber", "socialsecurity", "nationalid", "taxid", "passport", "license", "licence",
  "email", "phone", "mobile", "username", "nickname", "displayname", "firstname", "lastname", "middlename",
  "fullname", "surname", "address", "street", "postal", "postcode", "zipcode", "birth", "latitude", "longitude",
  "geolocation",
];

/** Matched as whole words of the key ("ip_address" has "ip", "zip" has no "ip"), so short words do not over-match. */
export const SENSITIVE_WORDS = [
  "name", "names", "handle", "card", "pan", "ssn", "sin", "dob", "ip", "zip", "city", "otp", "pin", "jwt", "bearer",
  "mail", "tel", "fax", "lat", "lng", "lon", "location", "login",
];

/** Well-known credential prefixes that would otherwise look like prefixed public IDs (`sk_4eC39HqLy…`, `ghp_…`). */
const SECRET_PREFIX = /^(?:sk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|whsec|shpat|shpss|npm|pypi|key|secret|token|pat)_/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CODE = /^[a-z][a-z0-9_.-]{0,31}$/;
const SHORT_NUMBER = /^-?\d{1,4}$/;
const DIGITS = /^\d+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const PHONE = /^\+?[\d\s().-]{7,24}$/;
const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/** @param {string} key */
function wordsOf(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** @param {string} text */
const isIsoDate = (text) => ISO_DATE.test(text) && !Number.isNaN(Date.parse(text));

/**
 * @param {{ salt: string, idPattern: string, redactKeys?: string[] }} options
 */
export function createScrubber({ salt, idPattern, redactKeys = [] }) {
  const idRegex = new RegExp(idPattern);
  const substrings = [...SENSITIVE_SUBSTRINGS, ...redactKeys.map((key) => wordsOf(key).join("")).filter(Boolean)];
  const words = new Set(SENSITIVE_WORDS);
  const hmacKey = crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // An unhandled rejection here would surface outside record(); callers see the failure when they await hash().
  // oxlint-disable-next-line intersite/no-empty-catch -- only marks the rejection handled; hash() rethrows it to its caller
  hmacKey.catch(() => {});

  /** HMAC-SHA256(salt, text) as hex. @param {string} text */
  async function hash(text) {
    const signature = await crypto.subtle.sign("HMAC", await hmacKey, enc.encode(text));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** @param {string} key */
  function isSensitive(key) {
    const parts = wordsOf(key);
    const joined = parts.join("");
    return parts.some((part) => words.has(part)) || substrings.some((needle) => joined.includes(needle));
  }

  /** @param {string} text */
  const isId = (text) => idRegex.test(text) && !SECRET_PREFIX.test(text);
  /** "cardId", "address_ids": an ID under these is an opaque reference, not the sensitive value. @param {string} key */
  const isIdKey = (key) => ["id", "ids", "uuid"].includes(wordsOf(key).at(-1) ?? "");
  /** Lowercase hex or digit-heavy strings are secrets, phone numbers or birth years, not enum codes. @param {string} text */
  const looksRandom = (text) => text.replace(/\D/g, "").length >= 4 || (text.length >= 16 && /^[0-9a-f]+$/.test(text));

  /** @param {string} text */
  function isStructural(text) {
    return isId(text) || SHORT_NUMBER.test(text) || isIsoDate(text) || (CODE.test(text) && !looksRandom(text));
  }

  /** A stable stand-in with the same form. @param {string} text */
  async function fakeString(text) {
    const digest = await hash(text);
    const short = digest.slice(0, 8);
    if (EMAIL.test(text)) return `u${short}@example.test`;
    if (URL_LIKE.test(text)) return `https://example.test/${short}`;
    if (isIsoDate(text)) {
      const date = new Date(Date.UTC(1970, 0, 1) + (Number.parseInt(short, 16) % 20_000) * 86_400_000).toISOString();
      return text.length === 10 ? date.slice(0, 10) : date;
    }
    const digitStream = digest.replace(/[a-f]/g, (letter) => String(letter.charCodeAt(0) % 10));
    if (DIGITS.test(text)) return digitStream.repeat(Math.ceil(text.length / 64)).slice(0, text.length);
    const digitCount = text.replace(/\D/g, "").length;
    if (PHONE.test(text) && digitCount >= 7 && digitCount <= 15) return `+1555${digitStream.slice(0, 7)}`;
    return `text_${short}`;
  }

  /** Same number of integer digits and sign; a fraction stays a fraction. @param {number} number */
  async function fakeNumber(number) {
    if (!Number.isFinite(number)) return 0;
    const seed = Number.parseInt((await hash(String(number))).slice(0, 12), 16);
    const digits = Math.min(String(Math.trunc(Math.abs(number))).length, 12);
    let out = seed % 10 ** digits;
    if (!Number.isInteger(number)) out += (seed % 99 + 1) / 100;
    return number < 0 ? -out : out;
  }

  /** @param {string} key */
  async function scrubKey(key) {
    return IDENT_KEY.test(key) || isId(key) ? key : fakeString(key);
  }

  /**
   * Scrub any JSON value. `key` is the property name it sits under; sensitivity is inherited by everything inside.
   * @param {unknown} value @param {string} [key] @param {boolean} [inherited]
   * @returns {Promise<unknown>}
   */
  async function scrub(value, key = "", inherited = false) {
    const hot = inherited || isSensitive(key);
    if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
    if (typeof value === "number") return hot ? fakeNumber(value) : value;
    if (typeof value === "string") {
      if (hot) return isIdKey(key) && isId(value) ? value : fakeString(value);
      return isStructural(value) ? value : fakeString(value);
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => scrub(item, key, hot)));
    if (typeof value === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [childKey, child] of Object.entries(value)) out[await scrubKey(childKey)] = await scrub(child, childKey, hot);
      return out;
    }
    return null;
  }

  /** Rewrite only the object keys of a JSON value, so its shape and ID pointers cannot carry personal keys. @param {unknown} value @returns {Promise<unknown>} */
  async function scrubKeys(value) {
    if (Array.isArray(value)) return Promise.all(value.map(scrubKeys));
    if (value === null || typeof value !== "object") return value;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, child] of Object.entries(value)) out[await scrubKey(key)] = await scrubKeys(child);
    return out;
  }

  return { hash, scrub, scrubKey, scrubKeys };
}

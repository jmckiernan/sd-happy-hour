/**
 * Detect an actual bot-challenge interstitial — not Cloudflare Turnstile
 * preconnects or Bot Fight precursor scripts that ship on live 200 pages.
 *
 * False positives here empty the inventory (ok:false / blocked:true), which
 * used to surface as media_unreadable when candidateUrls was [].
 */

const INTERSTITIAL_RE = /cf-browser-verification|x-vercel-challenge|vercel-mitigated/i;
const JUST_A_MOMENT_RE = /just a moment/i;
const CHALLENGE_INFRA_RE = /challenges\.cloudflare\.com|cdn-cgi\/challenge/i;

/** Visible copy shorter than this on a "challenge-looking" document is a waiting room. */
const MIN_LIVE_PAGE_CHARS = 400;

function visibleTextLength(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function isCloudflareChallenge(html) {
  if (typeof html !== 'string' || !html) return false;
  if (INTERSTITIAL_RE.test(html)) return true;
  if (visibleTextLength(html) >= MIN_LIVE_PAGE_CHARS) return false;
  return JUST_A_MOMENT_RE.test(html) || CHALLENGE_INFRA_RE.test(html);
}

/**
 * Ad / tracker / popup domain blocklist.
 *
 * Used by the browser bypass engine to abort ad requests and to close
 * popup tabs that open ad pages after clicking "Get Link" / "Continue".
 * Matching is done on the hostname (substring match), so subdomains
 * like `www.popads.net` or `c1.adsterra.com` are caught too.
 */

const AD_DOMAIN_FRAGMENTS: string[] = [
  // Google ad stack
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  // Popup / popunder networks
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "propellerclick.com",
  "adsterra.com",
  "exoclick.com",
  "clickadu.com",
  "hilltopads.net",
  "ad-maven.com",
  "adcash.com",
  "yllix.com",
  "popunder",
  "popupads",
  // Native / push ad networks
  "taboola.com",
  "outbrain.com",
  "mgid.com",
  "revcontent.com",
  "adnxs.com",
  "criteo.com",
  "adskeeper",
  "dats",
  // Misc trackers often bundled on shortener pages
  "hotjar.com",
  "fullstory.com",
  "mouseflow.com",
];

/**
 * Returns true if the URL belongs to a known ad / tracker / popup domain.
 * Never throws — unparsable input returns false.
 */
export function isAdUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  return AD_DOMAIN_FRAGMENTS.some((frag) => hostname.includes(frag));
}

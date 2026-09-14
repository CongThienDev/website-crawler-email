const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "yclid",
  "gbraid",
  "wbraid",
]);

const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "::1"]);
// These are profile/search/map pages, not the business website itself. They are
// commonly present in map exports and almost always return a block page.
const NON_WEBSITE_HOSTS = new Set([
  "google.com",
  "googleusercontent.com",
  "maps.google.com",
  "maps.apple.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "yelp.com",
  "yellowpages.com",
]);

function isNonWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return [...NON_WEBSITE_HOSTS].some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function normalizeWebsite(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || BLOCKED_HOSTS.has(hostname) || isPrivateIpv4(hostname) || isNonWebsiteHost(hostname)) return null;
    url.hostname = hostname;
    url.hash = "";
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParam(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return null;
  }
}

export function crawlKey(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const path = parsed.pathname.replace(/\/$/, "") || "/";
  return `${host}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
}

export function sameSite(left: string, right: string): boolean {
  try {
    const a = new URL(left).hostname.toLowerCase().replace(/^www\./, "");
    const b = new URL(right).hostname.toLowerCase().replace(/^www\./, "");
    return a === b;
  } catch {
    return false;
  }
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

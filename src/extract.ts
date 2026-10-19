import * as cheerio from "cheerio";
import type { EmailHit } from "./types.js";
import { sameSite } from "./url.js";

// Deliberately use a practical public-email grammar instead of the full RFC grammar.
// The full grammar permits `/` in a local part, which makes CDN versions and URL
// paths such as `slick-carousel@1.8.1` look like email addresses.
const EMAIL_RE = /[a-z0-9.!#$%&'*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const BAD_LOCAL_PARTS = new Set([
  "example", "email", "name", "yourname", "user", "username", "test",
  "youremail", "your.email", "johndoe", "john.doe", "janedoe", "jane.doe", "firstname", "first.last", "firstname.lastname",
]);
// Placeholder and platform addresses (site builders, error trackers): never a contact email. Subdomains match too.
const BAD_DOMAINS = [
  "example.com", "example.org", "example.net", "domain.com", "email.com", "mysite.com", "yoursite.com",
  "yourdomain.com", "website.com", "company.com", "sentry.io", "wixpress.com", "wix.com", "squarespace.com",
  "godaddy.com", "weebly.com", "editmysite.com", "duda.co", "hello.com",
];
const isBadDomain = (domain: string): boolean => BAD_DOMAINS.some((bad) => domain === bad || domain.endsWith(`.${bad}`));
const ASSET_SUFFIXES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".css",
  ".js",
  ".woff",
  ".woff2",
  ".ttf",
];

// Matched as substrings of the link path + text, best first. US local-service sites (the main market) often put
// the address on quote/estimate forms or "reach us" pages; foreign terms stay last.
const CONTACT_TERMS = [
  "contact",
  "get-in-touch",
  "get in touch",
  "reach",
  "email",
  "quote",
  "estimate",
  "about",
  "team",
  "staff",
  "people",
  "locations",
  "connect",
  "support",
  "impressum",
  "kontakt",
  "contato",
  "contacto",
  "legal",
  "nous-contacter",
];

function decodeCloudflare(hex: string): string | null {
  if (!/^[a-f\d]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let value = "";
  for (let index = 2; index < hex.length; index += 2) {
    value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16) ^ key);
  }
  return value;
}

export function isValidEmail(candidate: string): boolean {
  const email = candidate.trim().toLowerCase().replace(/^mailto:/, "");
  if (email.length > 254 || !email.includes("@") || email.includes("..")) return false;
  const [local, domain, ...extra] = email.split("@");
  if (!local || !domain || extra.length || local.length > 64) return false;
  if (/[\\/:]/.test(local) || local.startsWith(".") || local.endsWith(".")) return false;
  if (BAD_LOCAL_PARTS.has(local) || isBadDomain(domain)) return false;
  if (ASSET_SUFFIXES.some((suffix) => email.endsWith(suffix))) return false;
  if (/^(no-?reply|donotreply|privacyplease)@/i.test(email)) return false;
  if (/\.(local|invalid|test)$/i.test(domain)) return false;
  const labels = domain.split(".");
  const tld = labels.at(-1) ?? "";
  if (labels.length < 2 || !/^[a-z]{2,63}$/i.test(tld)) return false;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  return EMAIL_RE.test(email) && ((EMAIL_RE.lastIndex = 0), true);
}

function scoreEmail(email: string, sourceType: EmailHit["sourceType"], pageUrl: string): number {
  let score = sourceType === "mailto" ? 30 : sourceType === "cloudflare" ? 25 : 20;
  const [local, domain] = email.split("@");
  const pageDomain = new URL(pageUrl).hostname.replace(/^www\./, "");
  if (domain === pageDomain || pageDomain.endsWith(`.${domain}`)) score += 35;
  if (/^(info|contact|hello|office|admin|sales|support|reception|enquiries|inquiries)$/i.test(local)) score += 15;
  if (/gmail\.com$|outlook\.com$|yahoo\.com$|hotmail\.com$/i.test(domain)) score -= 5;
  return score;
}

function addHits(
  hits: Map<string, EmailHit>,
  candidates: Iterable<string>,
  sourceUrl: string,
  sourceType: EmailHit["sourceType"],
): void {
  for (const value of candidates) {
    const email = value.trim().toLowerCase().replace(/[),.;:]+$/, "");
    if (!isValidEmail(email)) continue;
    const hit: EmailHit = { email, sourceUrl, sourceType, score: scoreEmail(email, sourceType, sourceUrl) };
    const current = hits.get(email);
    if (!current || hit.score > current.score) hits.set(email, hit);
  }
}

function regexEmails(value: string): string[] {
  EMAIL_RE.lastIndex = 0;
  return value.match(EMAIL_RE) ?? [];
}

export function extractEmails(html: string, pageUrl: string): EmailHit[] {
  const $ = cheerio.load(html);
  const hits = new Map<string, EmailHit>();

  const mailtos: string[] = [];
  $('a[href^="mailto:" i]').each((_index, element) => {
    const href = $(element).attr("href") ?? "";
    const addressList = href.slice(7).split("?")[0] ?? "";
    try {
      mailtos.push(...decodeURIComponent(addressList).split(/[;,]/));
    } catch {
      mailtos.push(...addressList.split(/[;,]/));
    }
  });
  addHits(hits, mailtos, pageUrl, "mailto");

  const cloudflare: string[] = [];
  $("[data-cfemail]").each((_index, element) => {
    const decoded = decodeCloudflare($(element).attr("data-cfemail") ?? "");
    if (decoded) cloudflare.push(decoded);
  });
  addHits(hits, cloudflare, pageUrl, "cloudflare");

  $("script:not([type='application/ld+json']), style, noscript").remove();
  addHits(hits, regexEmails($.html()), pageUrl, "text");

  // text() joins sibling elements with no gap, gluing "a@b.com</a><span>Price" into "a@b.comPrice".
  $("body *").after(" ");
  const visibleText = $.root().text();
  // Bare " at " only counts when a bare " dot " follows ("info at acme dot com"); otherwise prose like
  // "located at hamburg.de" would become located@hamburg.de.
  const deobfuscated = visibleText
    .replace(/\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*/gi, "@")
    .replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\))\s*/gi, ".")
    .replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi, (_m, local: string, host: string) =>
      `${local}@${host.replace(/\s+dot\s+/gi, ".")}`,
    );
  addHits(hits, regexEmails(deobfuscated), pageUrl, "obfuscated");

  return [...hits.values()].sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
}

export interface LinkCandidate {
  url: string;
  score: number;
}

export function findContactLinks(html: string, pageUrl: string): LinkCandidate[] {
  const $ = cheerio.load(html);
  const found = new Map<string, number>();
  $("a[href]").each((_index, element) => {
    const href = ($(element).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    let target: URL;
    try {
      target = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(target.protocol) || !sameSite(target.toString(), pageUrl)) return;
    target.hash = "";
    const haystack = `${target.pathname} ${$(element).text()}`.toLowerCase();
    let score = 0;
    CONTACT_TERMS.forEach((term, index) => {
      if (haystack.includes(term)) score = Math.max(score, 100 - index * 3);
    });
    if (!score) return;
    if (/privacy|terms|cookie/i.test(haystack)) score -= 25;
    const normalized = target.toString();
    found.set(normalized, Math.max(found.get(normalized) ?? 0, score));
  });
  return [...found.entries()]
    .map(([url, score]) => ({ url, score }))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

// Early stop: a gmail or agency address alone is worth keeping, but more contact pages may hold the site's own.
export function hasOwnDomainEmail(hits: EmailHit[], siteUrl: string): boolean {
  const site = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
  return hits.some(({ email }) => {
    const domain = email.split("@")[1] ?? "";
    return domain === site || site.endsWith(`.${domain}`) || domain.endsWith(`.${site}`);
  });
}

export function mergeEmailHits(...groups: EmailHit[][]): EmailHit[] {
  const merged = new Map<string, EmailHit>();
  for (const group of groups) {
    for (const hit of group) {
      const current = merged.get(hit.email);
      if (!current || hit.score > current.score) merged.set(hit.email, hit);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
}

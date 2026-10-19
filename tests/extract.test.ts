import { describe, expect, it } from "vitest";
import { extractEmails, findContactLinks, hasOwnDomainEmail, isValidEmail } from "../src/extract.js";

describe("extractEmails", () => {
  it("extracts mailto, visible and obfuscated addresses", () => {
    const html = `
      <a href="mailto:Hello@Acme.com?subject=Hi">Email us</a>
      <p>Sales: sales@acme.com</p>
      <p>Support: help [at] acme [dot] com</p>
    `;
    const emails = extractEmails(html, "https://acme.com/contact").map((hit) => hit.email);
    expect(emails).toEqual(expect.arrayContaining(["hello@acme.com", "sales@acme.com", "help@acme.com"]));
  });

  it("does not turn prose with a bare 'at' into an email", () => {
    const html = `<p>We are located at hamburg.de and open at 9.</p><p>Write info at acme dot com</p>`;
    const emails = extractEmails(html, "https://acme.com/").map((hit) => hit.email);
    expect(emails).toEqual(["info@acme.com"]);
  });

  it("rejects placeholders and asset false positives", () => {
    expect(isValidEmail("test@example.com")).toBe(false);
    expect(isValidEmail("logo@2x.png")).toBe(false);
    expect(isValidEmail("team@real-company.com")).toBe(true);
    expect(isValidEmail("605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com")).toBe(false);
    expect(isValidEmail("john.doe@gmail.com")).toBe(false);
    expect(isValidEmail("fancyapps/ui@4.0")).toBe(false);
    expect(isValidEmail("slick-carousel@1.8.1")).toBe(false);
    expect(isValidEmail("//www.google.com/maps/place/company/@37.1")).toBe(false);
  });
});

describe("extractEmails text boundaries", () => {
  it("does not glue an address to the next element's text", () => {
    const html = `<div><b>brian@acme.com</b><span>Price</span></div><p>5pm</p><p>Email</p><p>admin at acme dot com</p>`;
    const emails = extractEmails(html, "https://acme.com/").map((hit) => hit.email);
    expect(emails).toEqual(["admin@acme.com", "brian@acme.com"]);
    expect(isValidEmail("contact@hello.com")).toBe(false);
  });
});

describe("findContactLinks", () => {
  it("keeps prioritized links on the same site", () => {
    const html = `
      <a href="/about">About us</a>
      <a href="https://example.com/contact">Contact</a>
      <a href="https://outside.test/contact">External</a>
    `;
    const links = findContactLinks(html, "https://www.example.com/");
    expect(links.map((link) => link.url)).toContain("https://example.com/contact");
    expect(links.some((link) => link.url.includes("outside.test"))).toBe(false);
  });
});

describe("hasOwnDomainEmail", () => {
  it("only counts addresses on the site's domain", () => {
    const hit = (email: string) => ({ email, sourceUrl: "", sourceType: "text" as const, score: 0 });
    expect(hasOwnDomainEmail([hit("owner@gmail.com")], "https://www.acme.com/")).toBe(false);
    expect(hasOwnDomainEmail([hit("info@acme.com")], "https://www.acme.com/")).toBe(true);
    expect(hasOwnDomainEmail([hit("info@acme.com")], "https://shop.acme.com/")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { extractEmails, findContactLinks, isValidEmail } from "../src/extract.js";

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

  it("rejects placeholders and asset false positives", () => {
    expect(isValidEmail("test@example.com")).toBe(false);
    expect(isValidEmail("logo@2x.png")).toBe(false);
    expect(isValidEmail("team@real-company.com")).toBe(true);
    expect(isValidEmail("fancyapps/ui@4.0")).toBe(false);
    expect(isValidEmail("slick-carousel@1.8.1")).toBe(false);
    expect(isValidEmail("//www.google.com/maps/place/company/@37.1")).toBe(false);
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

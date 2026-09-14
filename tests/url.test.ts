import { describe, expect, it } from "vitest";
import { crawlKey, normalizeWebsite, sameSite } from "../src/url.js";

describe("normalizeWebsite", () => {
  it("adds a scheme and removes tracking parameters", () => {
    expect(normalizeWebsite("Example.COM/contact?utm_source=google&lang=en#top")).toBe(
      "https://example.com/contact?lang=en",
    );
  });

  it("rejects non-web and local URLs", () => {
    expect(normalizeWebsite("mailto:test@example.com")).toBeNull();
    expect(normalizeWebsite("http://localhost:3000")).toBeNull();
    expect(normalizeWebsite("http://192.168.1.4")).toBeNull();
    expect(normalizeWebsite("https://www.google.com/maps/place/company")).toBeNull();
    expect(normalizeWebsite("https://facebook.com/example")).toBeNull();
  });
});

describe("site identity", () => {
  it("treats www and apex hosts as the same site", () => {
    expect(sameSite("https://www.example.com/a", "https://example.com/b")).toBe(true);
    expect(crawlKey("https://www.example.com/")).toBe("example.com/");
  });
});

import { describe, expect, it } from "vitest";
import { AdaptiveConcurrency } from "../src/crawler.js";

describe("AdaptiveConcurrency", () => {
  it("ignores per-site 403s and backs off on 429", () => {
    const adaptive = new AdaptiveConcurrency(25);
    for (let i = 0; i < 10; i += 1) adaptive.observe(403, "http_403");
    expect(adaptive.current).toBe(25);
    adaptive.observe(429, "http_429");
    expect(adaptive.current).toBe(18);
  });
});

import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_NAME,
  credentialsMatch,
  expiredSessionCookie,
  loadAuthConfig,
  LoginRateLimiter,
  readCookie,
  sessionCookie,
  SessionStore,
} from "../src/auth.js";

describe("UI authentication", () => {
  it("requires explicit credentials and a non-trivial password", () => {
    expect(() => loadAuthConfig({})).toThrow(/UI_USERNAME/);
    expect(() => loadAuthConfig({ UI_USERNAME: "admin", UI_PASSWORD: "short" })).toThrow(/ít nhất 8/);
    expect(loadAuthConfig({ UI_USERNAME: " admin ", UI_PASSWORD: "long-password", UI_SESSION_HOURS: "2" })).toMatchObject({
      username: "admin",
      sessionTtlMs: 2 * 60 * 60 * 1000,
    });
    expect(loadAuthConfig({ UI_USERNAME: "admin", UI_PASSWORD: "long-password", UI_SESSION_HOURS: "9999" }).sessionTtlMs)
      .toBe(720 * 60 * 60 * 1000);
  });

  it("matches both username and password", () => {
    const config = { username: "admin", password: "long-password" };
    expect(credentialsMatch("admin", "long-password", config)).toBe(true);
    expect(credentialsMatch("admin", "wrong-password", config)).toBe(false);
    expect(credentialsMatch("other", "long-password", config)).toBe(false);
  });

  it("creates, expires, and revokes opaque sessions", () => {
    const store = new SessionStore(1_000);
    const { token } = store.create("admin", 100);
    expect(token).not.toContain("admin");
    expect(store.get(token, 1_099)?.username).toBe("admin");
    expect(store.get(token, 1_100)).toBeUndefined();

    const second = store.create("admin", 200).token;
    store.revoke(second);
    expect(store.get(second, 201)).toBeUndefined();
  });

  it("serializes and reads the session cookie safely", () => {
    const cookie = sessionCookie("token/value", 60_000, true);
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=token%2Fvalue`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(readCookie(`other=1; ${AUTH_COOKIE_NAME}=token%2Fvalue`, AUTH_COOKIE_NAME)).toBe("token/value");
    expect(expiredSessionCookie(false)).toContain("Max-Age=0");
  });

  it("temporarily blocks repeated login failures", () => {
    const limiter = new LoginRateLimiter(2, 5_000);
    expect(limiter.recordFailure("client", 100)).toBe(1);
    expect(limiter.recordFailure("client", 200)).toBe(0);
    expect(limiter.retryAfterSeconds("client", 300)).toBe(5);
    expect(limiter.retryAfterSeconds("client", 5_201)).toBe(0);
    expect(limiter.recordFailure("client", 5_202)).toBe(1);
    limiter.reset("client");
    expect(limiter.retryAfterSeconds("client", 300)).toBe(0);
  });
});

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "crawler_session";

export interface AuthConfig {
  username: string;
  password: string;
  sessionTtlMs: number;
  secureCookie: boolean;
}

export interface AuthSession {
  username: string;
  expiresAt: number;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const username = environment.UI_USERNAME?.trim() ?? "";
  const password = environment.UI_PASSWORD ?? "";
  if (!username || !password) {
    throw new Error("Thiếu UI_USERNAME hoặc UI_PASSWORD. Hãy cấu hình tài khoản trước khi chạy UI.");
  }
  if (password.length < 8) {
    throw new Error("UI_PASSWORD phải có ít nhất 8 ký tự.");
  }
  if (username.length > 256 || password.length > 1024) {
    throw new Error("UI_USERNAME hoặc UI_PASSWORD dài hơn giới hạn cho phép.");
  }
  return {
    username,
    password,
    sessionTtlMs: Math.min(parsePositiveNumber(environment.UI_SESSION_HOURS, 12), 720) * 60 * 60 * 1000,
    secureCookie: environment.UI_COOKIE_SECURE === "true",
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function credentialsMatch(
  submittedUsername: string,
  submittedPassword: string,
  config: Pick<AuthConfig, "username" | "password">,
): boolean {
  return timingSafeEqual(digest(submittedUsername), digest(config.username))
    && timingSafeEqual(digest(submittedPassword), digest(config.password));
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

export class SessionStore {
  private readonly sessions = new Map<string, AuthSession>();

  constructor(private readonly ttlMs: number) {}

  create(username: string, now = Date.now()): { token: string; session: AuthSession } {
    this.removeExpired(now);
    const token = randomBytes(32).toString("base64url");
    const session = { username, expiresAt: now + this.ttlMs };
    this.sessions.set(digest(token).toString("hex"), session);
    return { token, session };
  }

  get(token: string | undefined, now = Date.now()): AuthSession | undefined {
    if (!token) return undefined;
    const key = digest(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      return undefined;
    }
    return session;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(digest(token).toString("hex"));
  }

  private removeExpired(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

interface LoginAttempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly maximumFailures = 5,
    private readonly blockMs = 15 * 60 * 1000,
  ) {}

  retryAfterSeconds(key: string, now = Date.now()): number {
    const attempt = this.attempts.get(key);
    if (!attempt) return 0;
    if (attempt.blockedUntil > 0 && attempt.blockedUntil <= now) {
      this.attempts.delete(key);
      return 0;
    }
    if (attempt.blockedUntil <= now) return 0;
    return Math.max(1, Math.ceil((attempt.blockedUntil - now) / 1000));
  }

  recordFailure(key: string, now = Date.now()): number {
    const current = this.attempts.get(key);
    const withinWindow = current && now - current.firstFailureAt < this.blockMs;
    const failures = withinWindow ? current.failures + 1 : 1;
    const blockedUntil = failures >= this.maximumFailures ? now + this.blockMs : 0;
    this.attempts.set(key, { failures, firstFailureAt: withinWindow ? current.firstFailureAt : now, blockedUntil });
    return Math.max(0, this.maximumFailures - failures);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

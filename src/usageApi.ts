import {
  ClaudeOauth,
  isTokenExpired,
  readCredentials,
  writeOauth,
} from "./credentials";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const BETA_HEADER = "oauth-2025-04-20";
// Usage API expects a Claude Code UA; the token endpoint rate-limits that UA.
const USAGE_USER_AGENT = "claude-code/2.1.317";
const TOKEN_USER_AGENT = "axios/1.7.9";

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  fetchedAt: number;
}

export type FetchResult =
  | { ok: true; snapshot: UsageSnapshot }
  | {
      ok: false;
      error: string;
      status?: number;
      retryAfterMs?: number;
      snapshot?: UsageSnapshot;
    };

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface RawUsageResponse {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function resolveScope(oauth: ClaudeOauth): string {
  if (oauth.scopes && oauth.scopes.length > 0) {
    return oauth.scopes.join(" ");
  }
  return OAUTH_SCOPE;
}

function normalizeUtilization(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) {
    return null;
  }
  // Some responses use 0–1; Claude Code usually uses 0–100.
  const pct = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

function parseWindow(raw: RawWindow | null | undefined): UsageWindow | null {
  if (!raw) {
    return null;
  }
  const utilization = normalizeUtilization(raw.utilization ?? null);
  if (utilization == null) {
    return null;
  }
  return {
    utilization,
    resetsAt: raw.resets_at ?? null,
  };
}

function parseSnapshot(data: RawUsageResponse): UsageSnapshot {
  return {
    fiveHour: parseWindow(data.five_hour),
    sevenDay: parseWindow(data.seven_day),
    sevenDayOpus: parseWindow(data.seven_day_opus),
    sevenDaySonnet: parseWindow(data.seven_day_sonnet),
    fetchedAt: Date.now(),
  };
}

function isTerminalRefreshFailure(status: number, body: TokenResponse): boolean {
  if (status === 400 || status === 401) {
    const code = (body.error || "").toLowerCase();
    return (
      code === "invalid_grant" ||
      code === "invalid_request" ||
      /invalid|revoked|expired/i.test(body.error_description || "")
    );
  }
  return false;
}

async function postRefresh(
  url: string,
  refreshToken: string,
  scope: string,
  asJson: boolean
): Promise<{ ok: true; data: TokenResponse } | { ok: false; status: number; data: TokenResponse; terminal: boolean }> {
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope,
  };
  const body = asJson
    ? JSON.stringify(payload)
    : new URLSearchParams(payload).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": asJson
        ? "application/json"
        : "application/x-www-form-urlencoded",
      "User-Agent": TOKEN_USER_AGENT,
      Accept: "application/json",
    },
    body,
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    data = {};
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data,
      terminal: isTerminalRefreshFailure(res.status, data),
    };
  }
  return { ok: true, data };
}

/**
 * Refresh Claude Code OAuth. Refresh tokens are single-use, so we:
 * 1) re-read credentials (Claude Code may have already rotated),
 * 2) POST once per attempt with the live refresh token,
 * 3) persist the rotated pair before returning.
 */
async function refreshAccessToken(
  claudeDir: string,
  oauth: ClaudeOauth
): Promise<ClaudeOauth | null> {
  // Prefer whatever is currently on disk — Claude Code may have refreshed already.
  const live = readCredentials(claudeDir)?.claudeAiOauth ?? oauth;
  if (
    live.accessToken &&
    live.accessToken !== oauth.accessToken &&
    !isTokenExpired(live)
  ) {
    return live;
  }

  const refreshToken = live.refreshToken || oauth.refreshToken;
  if (!refreshToken) {
    return null;
  }

  const scope = resolveScope(live);
  // Current Claude Code: JSON to platform.claude.com. Keep form + console as fallbacks.
  const attempts: Array<{ url: string; asJson: boolean }> = [
    { url: TOKEN_URLS[0], asJson: true },
    { url: TOKEN_URLS[0], asJson: false },
    { url: TOKEN_URLS[1], asJson: true },
    { url: TOKEN_URLS[1], asJson: false },
  ];

  for (const attempt of attempts) {
    try {
      const result = await postRefresh(
        attempt.url,
        refreshToken,
        scope,
        attempt.asJson
      );
      if (!result.ok) {
        if (result.terminal) {
          // Dead grant — don't burn retries against other encodings/hosts.
          return null;
        }
        continue;
      }
      if (!result.data.access_token) {
        continue;
      }

      const updated: ClaudeOauth = {
        ...live,
        accessToken: result.data.access_token,
        // Refresh tokens are single-use; keep old only if server omitted a new one.
        refreshToken: result.data.refresh_token ?? refreshToken,
        expiresAt: Date.now() + (result.data.expires_in ?? 3600) * 1000,
        scopes: result.data.scope
          ? result.data.scope.split(/\s+/).filter(Boolean)
          : live.scopes,
      };
      // Must persist: the old refresh token is already spent server-side.
      writeOauth(claudeDir, updated);
      return updated;
    } catch {
      continue;
    }
  }
  return null;
}

async function ensureAccessToken(
  claudeDir: string
): Promise<{ oauth: ClaudeOauth } | { error: string }> {
  const creds = readCredentials(claudeDir);
  let oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken && !oauth?.refreshToken) {
    return {
      error: "No Claude Code OAuth token. Run `claude auth login` first.",
    };
  }
  if (!oauth) {
    return {
      error: "No Claude Code OAuth token. Run `claude auth login` first.",
    };
  }

  if (!oauth.accessToken || isTokenExpired(oauth)) {
    const refreshed = await refreshAccessToken(claudeDir, oauth);
    if (!refreshed?.accessToken) {
      return {
        error: "Claude login expired. Run `claude auth login`.",
      };
    }
    oauth = refreshed;
  }
  return { oauth };
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const asSeconds = Number(header);
  if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
    // Some responses send Retry-After: 0 — still back off a bit.
    return Math.max(asSeconds, 1) * 1000;
  }
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    return Math.max(asDate - Date.now(), 1000);
  }
  return undefined;
}

async function usageRequest(accessToken: string): Promise<Response> {
  return fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": BETA_HEADER,
      "User-Agent": USAGE_USER_AGENT,
    },
  });
}

export async function fetchUsage(claudeDir: string): Promise<FetchResult> {
  const auth = await ensureAccessToken(claudeDir);
  if ("error" in auth) {
    return { ok: false, error: auth.error };
  }

  try {
    let res = await usageRequest(auth.oauth.accessToken);

    if (res.status === 401 || res.status === 403) {
      // Token rejected — refresh once then retry.
      const refreshed = await refreshAccessToken(claudeDir, auth.oauth);
      if (!refreshed?.accessToken) {
        return {
          ok: false,
          status: res.status,
          error: "Claude login needed. Run `claude auth login`.",
        };
      }
      res = await usageRequest(refreshed.accessToken);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          error: "Claude login needed. Run `claude auth login`.",
        };
      }
    }

    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: "Rate limited by usage API",
        retryAfterMs: retryAfterMs(res),
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Usage API HTTP ${res.status}`,
        retryAfterMs: retryAfterMs(res),
      };
    }

    const data = (await res.json()) as RawUsageResponse;
    return { ok: true, snapshot: parseSnapshot(data) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}

export function nextBackoffMs(previousMs?: number): number {
  const base = previousMs && previousMs > 0 ? previousMs * 2 : 60_000;
  const capped = Math.min(base, 10 * 60_000);
  const jitter = Math.floor(Math.random() * 5_000);
  return capped + jitter;
}

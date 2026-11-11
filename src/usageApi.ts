import {
  ClaudeOauth,
  isTokenExpired,
  readCredentials,
  writeOauth,
} from "./credentials";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

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

async function refreshAccessToken(
  claudeDir: string,
  oauth: ClaudeOauth
): Promise<ClaudeOauth | null> {
  if (!oauth.refreshToken) {
    return null;
  }
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
    });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      return null;
    }
    const updated: ClaudeOauth = {
      ...oauth,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? oauth.refreshToken,
      expiresAt: json.expires_in
        ? Date.now() + json.expires_in * 1000
        : oauth.expiresAt,
    };
    try {
      writeOauth(claudeDir, updated);
    } catch {
      // still usable in-memory for this poll
    }
    return updated;
  } catch {
    return null;
  }
}

async function ensureAccessToken(
  claudeDir: string
): Promise<{ oauth: ClaudeOauth } | { error: string }> {
  const creds = readCredentials(claudeDir);
  let oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return {
      error: "No Claude Code OAuth token. Run `claude auth login` first.",
    };
  }
  if (isTokenExpired(oauth)) {
    const refreshed = await refreshAccessToken(claudeDir, oauth);
    if (!refreshed) {
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

export async function fetchUsage(claudeDir: string): Promise<FetchResult> {
  const auth = await ensureAccessToken(claudeDir);
  if ("error" in auth) {
    return { ok: false, error: auth.error };
  }

  try {
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.oauth.accessToken}`,
        "anthropic-beta": BETA_HEADER,
        "User-Agent": USER_AGENT,
      },
    });

    if (res.status === 401 || res.status === 403) {
      // Try one refresh then retry once.
      const refreshed = await refreshAccessToken(claudeDir, auth.oauth);
      if (!refreshed) {
        return {
          ok: false,
          status: res.status,
          error: "Claude login needed. Run `claude auth login`.",
        };
      }
      const retry = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${refreshed.accessToken}`,
          "anthropic-beta": BETA_HEADER,
          "User-Agent": USER_AGENT,
        },
      });
      if (!retry.ok) {
        return {
          ok: false,
          status: retry.status,
          error: `Usage API HTTP ${retry.status}`,
          retryAfterMs: retryAfterMs(retry),
        };
      }
      const data = (await retry.json()) as RawUsageResponse;
      return { ok: true, snapshot: parseSnapshot(data) };
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

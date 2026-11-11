import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ClaudeOauth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

export interface CredentialsFile {
  claudeAiOauth?: ClaudeOauth;
}

export function resolveClaudeDir(configuredDir?: string): string {
  const trimmed = configuredDir?.trim();
  if (trimmed) {
    return path.resolve(expandHome(trimmed));
  }
  const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envDir) {
    return path.resolve(expandHome(envDir));
  }
  return path.join(os.homedir(), ".claude");
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function credentialsPath(claudeDir: string): string {
  return path.join(claudeDir, ".credentials.json");
}

export function readCredentials(claudeDir: string): CredentialsFile | null {
  const filePath = credentialsPath(claudeDir);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as CredentialsFile;
  } catch {
    return null;
  }
}

export function writeOauth(claudeDir: string, oauth: ClaudeOauth): void {
  const filePath = credentialsPath(claudeDir);
  let existing: CredentialsFile = {};
  try {
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, "utf8")) as CredentialsFile;
    }
  } catch {
    existing = {};
  }
  existing.claudeAiOauth = { ...existing.claudeAiOauth, ...oauth };
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function isTokenExpired(oauth: ClaudeOauth, skewMs = 60_000): boolean {
  if (!oauth.expiresAt) {
    return false;
  }
  return Date.now() >= oauth.expiresAt - skewMs;
}

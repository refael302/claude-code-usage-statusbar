import * as vscode from "vscode";
import {
  isFresh,
  isInBackoff,
  readCache,
  writeCache,
  type SharedCache,
} from "./cache";
import { resolveClaudeDir } from "./credentials";
import { UsageStatusBar, type StatusBarConfig } from "./statusBar";
import { fetchUsage, nextBackoffMs } from "./usageApi";

let statusBar: UsageStatusBar | undefined;
let timer: NodeJS.Timeout | undefined;
let refreshing = false;

function readConfig(): StatusBarConfig & {
  refreshIntervalSeconds: number;
  claudeDir: string;
} {
  const cfg = vscode.workspace.getConfiguration("claudeUsage");
  return {
    refreshIntervalSeconds: Math.max(
      60,
      cfg.get<number>("refreshIntervalSeconds", 180)
    ),
    warningThreshold: cfg.get<number>("warningThreshold", 60),
    errorThreshold: cfg.get<number>("errorThreshold", 80),
    showSevenDay: cfg.get<boolean>("showSevenDay", true),
    priority: cfg.get<number>("statusBarPriority", 100),
    claudeDir: resolveClaudeDir(cfg.get<string>("claudeDir", "")),
  };
}

function recreateStatusBar(priority: number): void {
  statusBar?.dispose();
  statusBar = new UsageStatusBar(priority);
}

async function refresh(force: boolean): Promise<void> {
  if (refreshing) {
    return;
  }
  const config = readConfig();
  if (!statusBar) {
    recreateStatusBar(config.priority);
  }

  if (!force && !vscode.window.state.focused) {
    return;
  }

  const ttlMs = config.refreshIntervalSeconds * 1000;
  const cache = readCache();

  if (!force && isInBackoff(cache) && cache?.snapshot) {
    statusBar?.showSnapshot(
      cache.snapshot,
      config,
      `Backing off until ${new Date(cache.backoffUntil!).toLocaleTimeString()}`
    );
    return;
  }

  if (!force && isFresh(cache, ttlMs)) {
    statusBar?.showSnapshot(cache!.snapshot!, config);
    return;
  }

  if (!force && isInBackoff(cache) && !cache?.snapshot) {
    statusBar?.showError(cache?.error ?? "Rate limited");
    return;
  }

  refreshing = true;
  if (!cache?.snapshot) {
    statusBar?.showLoading();
  }

  try {
    const result = await fetchUsage(config.claudeDir);
    if (result.ok) {
      const next: SharedCache = {
        fetchedAt: result.snapshot.fetchedAt,
        snapshot: result.snapshot,
      };
      writeCache(next);
      statusBar?.showSnapshot(result.snapshot, config);
      return;
    }

    const loginNeeded =
      /login/i.test(result.error) ||
      result.status === 401 ||
      result.status === 403;

    if (loginNeeded) {
      statusBar?.showLoginNeeded(result.error);
      writeCache({
        fetchedAt: Date.now(),
        error: result.error,
        snapshot: cache?.snapshot,
      });
      return;
    }

    let backoffMs: number | undefined;
    if (result.status === 429) {
      backoffMs = result.retryAfterMs ?? nextBackoffMs(cache?.backoffMs);
    }

    const next: SharedCache = {
      fetchedAt: cache?.fetchedAt ?? Date.now(),
      snapshot: cache?.snapshot,
      error: result.error,
      backoffMs,
      backoffUntil: backoffMs ? Date.now() + backoffMs : undefined,
    };
    writeCache(next);

    if (cache?.snapshot) {
      statusBar?.showSnapshot(
        cache.snapshot,
        config,
        result.error +
          (backoffMs
            ? ` · retry in ${Math.ceil(backoffMs / 1000)}s`
            : "")
      );
    } else {
      statusBar?.showError(result.error);
    }
  } finally {
    refreshing = false;
  }
}

function schedule(): void {
  if (timer) {
    clearInterval(timer);
  }
  const { refreshIntervalSeconds } = readConfig();
  timer = setInterval(() => {
    void refresh(false);
  }, refreshIntervalSeconds * 1000);
}

export function activate(context: vscode.ExtensionContext): void {
  const config = readConfig();
  recreateStatusBar(config.priority);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.refresh", () =>
      refresh(true)
    ),
    vscode.commands.registerCommand("claudeUsage.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "claudeUsage"
      )
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeUsage")) {
        return;
      }
      const next = readConfig();
      recreateStatusBar(next.priority);
      schedule();
      void refresh(true);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void refresh(false);
      }
    }),
    {
      dispose: () => {
        if (timer) {
          clearInterval(timer);
        }
        statusBar?.dispose();
      },
    }
  );

  schedule();
  void refresh(true);
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
  statusBar?.dispose();
  statusBar = undefined;
}

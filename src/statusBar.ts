import * as vscode from "vscode";
import type { UsageSnapshot, UsageWindow } from "./usageApi";

export interface StatusBarConfig {
  warningThreshold: number;
  errorThreshold: number;
  showSevenDay: boolean;
  priority: number;
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) {
    return "unknown";
  }
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) {
    return resetsAt;
  }
  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) {
    return "soon";
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatPct(window: UsageWindow | null): string {
  if (!window) {
    return "—";
  }
  return `${Math.round(window.utilization)}%`;
}

function maxUtilization(snapshot: UsageSnapshot | undefined, showSevenDay: boolean): number {
  if (!snapshot) {
    return 0;
  }
  const values = [snapshot.fiveHour?.utilization ?? 0];
  if (showSevenDay && snapshot.sevenDay) {
    values.push(snapshot.sevenDay.utilization);
  }
  return Math.max(...values);
}

export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(priority: number) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      priority
    );
    this.item.command = "claudeUsage.refresh";
    this.item.tooltip = "Claude Code usage — click to refresh";
    this.item.text = "$(sync~spin) Claude…";
    this.item.show();
  }

  setPriority(priority: number): void {
    // VS Code StatusBarItem priority is fixed at creation; recreate is heavier.
    // Keep simple: priority only applied at construction via extension restart/config change recreate.
    void priority;
  }

  showLoading(): void {
    this.item.text = "$(sync~spin) Claude…";
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  showLoginNeeded(message: string): void {
    this.item.text = "$(warning) Claude: login needed";
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.item.color = undefined;
  }

  showError(message: string, last?: UsageSnapshot, cfg?: StatusBarConfig): void {
    if (last && cfg) {
      this.showSnapshot(last, cfg, `Last reading kept. ${message}`);
      return;
    }
    this.item.text = "$(error) Claude: error";
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  }

  showSnapshot(
    snapshot: UsageSnapshot,
    cfg: StatusBarConfig,
    note?: string
  ): void {
    const five = formatPct(snapshot.fiveHour);
    const parts = [`Claude 5h ${five}`];
    if (cfg.showSevenDay) {
      parts.push(`7d ${formatPct(snapshot.sevenDay)}`);
    }
    this.item.text = parts.join(" · ");

    const peak = maxUtilization(snapshot, cfg.showSevenDay);
    if (peak >= cfg.errorThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    } else if (peak >= cfg.warningThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      this.item.backgroundColor = undefined;
    }

    const lines: string[] = ["Claude Code quota usage", ""];
    lines.push(
      `5-hour: ${formatPct(snapshot.fiveHour)} used · resets in ${formatReset(
        snapshot.fiveHour?.resetsAt ?? null
      )}`
    );
    if (snapshot.sevenDay) {
      lines.push(
        `7-day: ${formatPct(snapshot.sevenDay)} used · resets in ${formatReset(
          snapshot.sevenDay.resetsAt
        )}`
      );
    }
    if (snapshot.sevenDayOpus) {
      lines.push(
        `7-day Opus: ${formatPct(snapshot.sevenDayOpus)} used · resets in ${formatReset(
          snapshot.sevenDayOpus.resetsAt
        )}`
      );
    }
    if (snapshot.sevenDaySonnet) {
      lines.push(
        `7-day Sonnet: ${formatPct(snapshot.sevenDaySonnet)} used · resets in ${formatReset(
          snapshot.sevenDaySonnet.resetsAt
        )}`
      );
    }
    lines.push("");
    lines.push(`Fetched: ${new Date(snapshot.fetchedAt).toLocaleString()}`);
    if (note) {
      lines.push(note);
    }
    lines.push("Click to refresh");
    this.item.tooltip = lines.join("\n");
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * agent/src/github-installations.ts
 *
 * GitHub App installation discovery and selection. discoverInstallations()
 * lists every installation of the App (App JWT only, paginated);
 * selectInstallations() is a pure function that narrows that list to the
 * installations this agent should use. Built for dependency injection
 * (injected fetchFn) so it's testable without a live GitHub App.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { type FetchFn, GitHubTokenManager } from "./github-app-auth.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredInstallation {
  id: number;
  /** Account login that owns the installation (org or user). */
  owner: string;
  /** Non-null when GitHub has suspended the installation. */
  suspendedAt: string | null;
}

export type DiscoveryResult =
  | { ok: true; installations: DiscoveredInstallation[] }
  | { ok: false; error: string };

export interface SelectedInstallation {
  id: number;
  /** null only for a pinned id GitHub did not return from discovery. */
  owner: string | null;
  suspended: boolean;
  pinned: boolean;
}

export interface InstallationSelection {
  installations: SelectedInstallation[];
  /** The pin if set, else the lowest selected id; null when nothing selected. */
  defaultId: number | null;
}

const INSTALLATIONS_URL = "https://api.github.com/app/installations";
const PER_PAGE = 100;
// Guard against a misbehaving server that never returns a short page.
const MAX_PAGES = 100;

// ─── Discovery ────────────────────────────────────────────────────────────────

interface RawInstallation {
  id: number;
  account?: { login?: string } | null;
  suspended_at?: string | null;
}

/**
 * Lists all installations of the App via GET /app/installations, following
 * pagination at 100 per page. Never throws — any failure is returned as an
 * error result so the caller can keep its last good list.
 */
export async function discoverInstallations(
  appJwt: string,
  fetchFn: FetchFn = fetch,
): Promise<DiscoveryResult> {
  const installations: DiscoveredInstallation[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await fetchFn(
        `${INSTALLATIONS_URL}?per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!resp.ok) {
        return {
          ok: false,
          error: `GET /app/installations failed: ${resp.status} ${resp.statusText}`,
        };
      }
      const raw = (await resp.json()) as RawInstallation[];
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          error: "GET /app/installations returned a non-array body",
        };
      }
      for (const r of raw) {
        installations.push({
          id: r.id,
          owner: r.account?.login ?? "",
          suspendedAt: r.suspended_at ?? null,
        });
      }
      if (raw.length < PER_PAGE) {
        return { ok: true, installations };
      }
    }
    return {
      ok: false,
      error: `GET /app/installations exceeded ${MAX_PAGES} pages`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────

export interface SelectInstallationsInput {
  discovered: DiscoveredInstallation[];
  /** Scoped repos as `org/repo` strings (agentReposRef.get()). */
  scopedRepos: string[];
  /** agentReposRef.hasSynced() — false means scope is unknown. */
  scopeSynced: boolean;
  /** GH_APP_INSTALLATION_ID, if set. */
  pinnedId?: number | null;
}

/**
 * Pure selection. An installation is used only if its owner is in repo scope
 * (case-insensitive) or it is the pinned id. A pinned id wins over any other
 * discovered id for the same owner. Unsynced scope means pinned-only (never an
 * empty set when a pin exists).
 */
export function selectInstallations(
  input: SelectInstallationsInput,
): InstallationSelection {
  const { discovered, scopedRepos, scopeSynced } = input;
  const pinnedId = input.pinnedId ?? null;

  const scopedOwners = new Set(
    scopedRepos.map((r) => r.split("/")[0]?.toLowerCase()).filter(Boolean),
  );

  const byOwner = new Map<string, SelectedInstallation>();
  const pinnedFound = discovered.find((d) => d.id === pinnedId);

  for (const d of discovered) {
    const key = d.owner.toLowerCase();
    const isPinned = d.id === pinnedId;
    if (!isPinned && (!scopeSynced || !scopedOwners.has(key))) continue;

    const existing = byOwner.get(key);
    if (existing?.pinned) continue;
    if (!isPinned && existing && existing.id < d.id) continue;
    byOwner.set(key, {
      id: d.id,
      owner: d.owner,
      suspended: d.suspendedAt !== null,
      pinned: isPinned,
    });
  }

  const installations = [...byOwner.values()];
  if (pinnedId !== null && !pinnedFound) {
    installations.push({
      id: pinnedId,
      owner: null,
      suspended: false,
      pinned: true,
    });
  }
  installations.sort((a, b) => a.id - b.id);

  const defaultId =
    pinnedId !== null
      ? pinnedId
      : installations.length > 0
        ? installations[0].id
        : null;

  return { installations, defaultId };
}

// ─── Manager ──────────────────────────────────────────────────────────────────

type ManagerAuthFn = ConstructorParameters<
  typeof GitHubTokenManager
>[0]["auth"];

/** Status classes carried on mint-failed events — never an error message. */
export type MintFailureClass = "4xx" | "5xx" | "network" | "other";

export type InstallationEvent =
  | { type: "discovered"; installationId: number; owner: string | null }
  | { type: "removed"; installationId: number }
  | { type: "minted"; installationId: number }
  | {
      type: "mint_failed";
      installationId: number;
      statusClass: MintFailureClass;
      status: number | null;
      broken: boolean;
    }
  | { type: "discovery_failed" };

export type InstallationHealth = "ok" | "broken" | "unknown";

export interface InstallationState {
  id: number;
  owner: string | null;
  pinned: boolean;
  health: InstallationHealth;
  /** Why the installation is broken; never contains token or key material. */
  reason: "suspended" | "mint_rejected" | null;
}

export interface InstallationsSnapshot {
  installations: InstallationState[];
  defaultId: number | null;
}

export interface GitHubInstallationsManagerOptions {
  /** @octokit/auth-app auth function (App JWT via `type: "app"`). */
  auth: ManagerAuthFn;
  fetchFn?: FetchFn;
  clock?: Clock;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  pinnedId?: number | null;
  refreshIntervalMs?: number;
  onEvent?: (event: InstallationEvent) => void;
  onChange?: (state: InstallationsSnapshot) => void;
}

// Shorter than GitHubTokenManager's REFRESH_BUFFER_MS so a tick always lands
// inside the pre-expiry window and re-mints before the token lapses.
const MANAGER_REFRESH_INTERVAL_MS = 4 * 60 * 1000;
const BROKEN_STATUSES = new Set([403, 404, 422]);

function failureClass(status: number | null): MintFailureClass {
  if (status === null) return "network";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

interface Tracked {
  state: InstallationState;
  tokens: GitHubTokenManager;
  lastToken: string | null;
}

/**
 * Composes one GitHubTokenManager per selected installation behind a single
 * refresh timer. A broken installation (suspended, or mint rejected with
 * 403/404/422) never affects the others; transient mint errors (5xx, network)
 * are retried on the next tick. Nothing here throws out of the timer, and no
 * token or key is ever logged or placed on an event.
 */
export class GitHubInstallationsManager {
  private readonly opts: GitHubInstallationsManagerOptions;
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly tracked = new Map<number, Tracked>();
  private defaultId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private lastSnapshot = "";

  constructor(opts: GitHubInstallationsManagerOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.clock = opts.clock ?? SystemClock();
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  }

  getState(): InstallationsSnapshot {
    return {
      installations: [...this.tracked.values()]
        .map((t) => ({ ...t.state }))
        .sort((a, b) => a.id - b.id),
      defaultId: this.defaultId,
    };
  }

  /** Returns a fresh installation token; throws if the installation is unknown or broken. */
  async getToken(installationId: number): Promise<string> {
    const t = this.tracked.get(installationId);
    if (!t) throw new Error(`unknown installation ${installationId}`);
    if (t.state.health === "broken") {
      throw new Error(`installation ${installationId} is broken`);
    }
    return t.tokens.getToken();
  }

  /** Starts the single refresh timer. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.setIntervalFn(() => {
      void this.refresh();
    }, this.opts.refreshIntervalMs ?? MANAGER_REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  /**
   * Re-runs discovery and selection. `scopeOwners` is the set of repo owners
   * the agent is scoped to, or null while scope is not yet synced. On a
   * discovery failure the previous installation list is kept untouched.
   */
  async reconcile(scopeOwners: string[] | null): Promise<void> {
    try {
      const jwt = (await this.opts.auth({ type: "app" })).token;
      const result = await discoverInstallations(jwt, this.fetchFn);
      if (!result.ok) {
        this.emit({ type: "discovery_failed" });
        return;
      }
      const selection = selectInstallations({
        discovered: result.installations,
        scopedRepos: (scopeOwners ?? []).map((o) => `${o}/-`),
        scopeSynced: scopeOwners !== null,
        pinnedId: this.opts.pinnedId,
      });
      const selectedIds = new Set(selection.installations.map((i) => i.id));

      for (const id of [...this.tracked.keys()]) {
        if (!selectedIds.has(id)) {
          this.tracked.delete(id);
          this.emit({ type: "removed", installationId: id });
        }
      }
      const suspendedById = new Map(
        result.installations.map((d) => [d.id, d.suspendedAt !== null]),
      );
      for (const sel of selection.installations) {
        const suspended = sel.suspended || suspendedById.get(sel.id) === true;
        const existing = this.tracked.get(sel.id);
        const state: InstallationState = {
          id: sel.id,
          owner: sel.owner,
          pinned: sel.pinned,
          // A mint rejection is retried after a reconcile; suspension is not.
          health: suspended ? "broken" : (existing?.state.health ?? "unknown"),
          reason: suspended ? "suspended" : (existing?.state.reason ?? null),
        };
        if (!suspended && state.reason === "mint_rejected") {
          state.health = "unknown";
          state.reason = null;
        }
        if (existing) {
          existing.state = state;
        } else {
          this.tracked.set(sel.id, {
            state,
            lastToken: null,
            tokens: new GitHubTokenManager({
              auth: this.opts.auth,
              installationId: sel.id,
              clock: this.clock,
            }),
          });
          this.emit({
            type: "discovered",
            installationId: sel.id,
            owner: sel.owner,
          });
        }
      }
      this.defaultId = selection.defaultId;
      this.notifyIfChanged();
    } catch (err) {
      console.error(
        "[github-installations] reconcile failed:",
        err instanceof Error ? err.name : "error",
      );
      this.emit({ type: "discovery_failed" });
    }
  }

  /** One timer tick: mint/refresh every non-broken installation independently. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all(
        [...this.tracked.values()]
          .filter((t) => t.state.health !== "broken")
          .map((t) => this.mintOne(t)),
      );
      this.notifyIfChanged();
    } catch (err) {
      console.error(
        "[github-installations] refresh failed:",
        err instanceof Error ? err.name : "error",
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async mintOne(t: Tracked): Promise<void> {
    const id = t.state.id;
    try {
      const token = await t.tokens.getToken();
      t.state.health = "ok";
      if (token !== t.lastToken) {
        t.lastToken = token;
        this.emit({ type: "minted", installationId: id });
      }
    } catch (err) {
      const status = statusOf(err);
      const broken = status !== null && BROKEN_STATUSES.has(status);
      if (broken) {
        t.state.health = "broken";
        t.state.reason = "mint_rejected";
        t.lastToken = null;
      }
      this.emit({
        type: "mint_failed",
        installationId: id,
        statusClass: failureClass(status),
        status,
        broken,
      });
    }
  }

  private emit(event: InstallationEvent): void {
    console.log(`[github-installations] ${JSON.stringify(event)}`);
    try {
      this.opts.onEvent?.(event);
    } catch {
      // a faulty listener must never break the refresh loop
    }
  }

  private notifyIfChanged(): void {
    const snapshot = this.getState();
    const key = JSON.stringify(snapshot);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    try {
      this.opts.onChange?.(snapshot);
    } catch {
      // a faulty listener must never break the refresh loop
    }
  }
}

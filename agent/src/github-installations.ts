/**
 * agent/src/github-installations.ts
 *
 * GitHub App installation discovery and selection. discoverInstallations()
 * lists every installation of the App (App JWT only, paginated);
 * selectInstallations() is a pure function that narrows that list to the
 * installations this agent should use. Built for dependency injection
 * (injected fetchFn) so it's testable without a live GitHub App.
 */

import type { FetchFn } from "./github-app-auth.ts";

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

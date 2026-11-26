/**
 * cursor-paging.ts (TPG-2.2) — stateless Prev/Next cursor paging for the
 * admin list pages that read task-store list endpoints.
 *
 * Task-store `?cursor=` / `nextCursor` is forward-only, so "Prev" needs the
 * cursors of the pages already visited. They live in the URL — no server
 * state:
 *
 *   ?cursor=<current page's start cursor>&prev=<c1>.<c2>…
 *
 * `prev` is the stack of start cursors of the pages strictly between the first
 * page and the current one (oldest first). The first page has no start cursor,
 * so it is implicit: a request with no `cursor` IS the first page, and Prev
 * from a page whose stack is empty goes back to it. Cursors are opaque
 * base64url (`[A-Za-z0-9_-]`), so `.` is a safe stack delimiter; anything else
 * in either param is ignored (treated as the first page) rather than forwarded
 * upstream.
 */

export interface CursorState {
  /** Start cursor of the current page; undefined on the first page. */
  cursor?: string;
  /** Start cursors of the pages between the first page and this one. */
  prev: string[];
}

const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const STACK_LIMIT = 50;

/** Parse `?cursor=` / `?prev=`; malformed input degrades to the first page. */
export function parseCursorState(
  cursorRaw: string | undefined,
  prevRaw: string | undefined,
): CursorState {
  if (!cursorRaw || !CURSOR_RE.test(cursorRaw)) return { prev: [] };
  const prev = (prevRaw ?? "").split(".").filter((s) => s !== "");
  if (prev.some((p) => !CURSOR_RE.test(p)))
    return { cursor: cursorRaw, prev: [] };
  return { cursor: cursorRaw, prev: prev.slice(-STACK_LIMIT) };
}

/** State for the page after this one (Next link). */
export function nextCursorState(
  state: CursorState,
  nextCursor: string,
): CursorState {
  return {
    cursor: nextCursor,
    prev: state.cursor ? [...state.prev, state.cursor].slice(-STACK_LIMIT) : [],
  };
}

/** State for the page before this one (Prev link); null on the first page. */
export function prevCursorState(state: CursorState): CursorState | null {
  if (!state.cursor) return null;
  if (state.prev.length === 0) return { prev: [] };
  return {
    cursor: state.prev[state.prev.length - 1],
    prev: state.prev.slice(0, -1),
  };
}

/** Write `cursor` / `prev` onto a URL's params (nothing for the first page). */
export function applyCursorState(
  params: URLSearchParams,
  state: CursorState | null,
): void {
  params.delete("cursor");
  params.delete("prev");
  if (!state?.cursor) return;
  params.set("cursor", state.cursor);
  if (state.prev.length > 0) params.set("prev", state.prev.join("."));
}

/** Cursor-paging inputs/outputs handed to a page renderer. */
export interface CursorPagination {
  /** Rows on this page. */
  count: number;
  limit: number;
  /** Total matching rows when known. */
  total?: number;
  state: CursorState;
  /** Opaque cursor for the next page; null/undefined on the last page. */
  nextCursor?: string | null;
}

const BTN = `class="btn btn-secondary" style="font-size:11px;padding:3px 10px"`;

/**
 * Prev/Next bar. `hrefFor(state)` builds a full page URL (filters preserved)
 * for a target cursor state. Rendered nothing for an empty single page.
 */
export function renderCursorPager(
  p: CursorPagination,
  hrefFor: (state: CursorState) => string,
  opts: { summary?: string; topPadding?: string } = {},
): string {
  const prevState = prevCursorState(p.state);
  const next = p.nextCursor ? nextCursorState(p.state, p.nextCursor) : null;
  if (p.count === 0 && !prevState && !next) return "";
  const summary =
    opts.summary ??
    `${p.count} shown${typeof p.total === "number" ? ` of ${p.total}` : ""}`;
  return `<div class="cursor-pager" style="display:flex;justify-content:space-between;align-items:center;padding:${opts.topPadding ?? "12px 0 0"};font-size:12px;color:var(--vos-text-muted, #6b7280)">
      <span>${summary}</span>
      <div style="display:flex;gap:4px">
        ${prevState ? `<a href="${hrefFor(prevState)}" rel="prev" ${BTN}>← Prev</a>` : ""}
        ${next ? `<a href="${hrefFor(next)}" rel="next" ${BTN}>Next →</a>` : ""}
      </div>
    </div>`;
}

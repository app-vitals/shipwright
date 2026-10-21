/**
 * task-store/src/blocked-by-type-parity.check.ts
 *
 * Compile-time-only parity check between admin's hand-mirrored `BlockedByEntry`
 * (admin/src/coding/admin-ui-work-item-pages.ts — kept deliberately decoupled
 * from @shipwright/task-store,
 * see the "avoids cross-package coupling" comments in that file) and the real
 * `BlockedByEntry` union in task-store/src/blocked-by.ts.
 *
 * This file has NO runtime behavior and is never imported by application code —
 * it exists purely so `tsc --noEmit` fails the build when task-store's union
 * gains (or loses) a variant that admin's mirror hasn't been updated to match.
 * It lives on the task-store side so admin never reaches outside admin/: it is
 * type-checked via `tsconfig.cross-package.json` (see task-store/package.json's
 * `typecheck` script), purely for this type-level comparison, with zero runtime
 * import and zero package.json dependency between the two packages.
 *
 * Intentionally NOT a strict two-way "every field on every variant matches"
 * check: task-store's `{ type: "hitl" }` variant has no `notified` field,
 * while admin's mirror carries an optional `notified?: true` used purely for
 * UI copy (see renderTaskDetailPage's blockers section) — that pre-existing,
 * known divergence is not a bug and must not fail this check. What this check
 * *does* guard: every variant (keyed by `type`) that exists on task-store's
 * side must have a same-`type` counterpart on admin's side that is at least
 * as permissive (i.e. every real value assignable to the task-store variant
 * must also be assignable to admin's matching variant). Add a new variant to
 * task-store's union without a matching admin variant, and the exhaustiveness
 * check below fails to compile.
 */

import type { BlockedByEntry as AdminBlockedByEntry } from "../../admin/src/coding/admin-ui-work-item-pages.ts";
import type { BlockedByEntry as RealBlockedByEntry } from "./blocked-by.ts";

// Every `type` discriminant present in task-store's real union.
type RealType = RealBlockedByEntry["type"];

// Every `type` discriminant present in admin's mirrored union.
type AdminType = AdminBlockedByEntry["type"];

/**
 * Fails to compile if task-store adds/renames a variant's `type` without a
 * same-named counterpart being added to admin's mirror. This is the actual
 * regression this file guards against (e.g. the missing "blocked" variant
 * that caused Sentry issue 7665355727).
 */
type _AssertEveryRealTypeHasAdminCounterpart = RealType extends AdminType
  ? true
  : [
      "missing admin BlockedByEntry variant for type",
      Exclude<RealType, AdminType>,
    ];
const _assertEveryRealTypeHasAdminCounterpart: _AssertEveryRealTypeHasAdminCounterpart = true;
void _assertEveryRealTypeHasAdminCounterpart;

/**
 * For each `type`, every real task-store shape must be assignable to admin's
 * matching shape (admin's mirror may be *more* permissive, e.g. the known
 * extra optional `notified` field on "hitl", but never *less* permissive —
 * it must still accept every real value task-store can actually produce).
 */
type AssertVariantAssignable<T extends RealType> =
  Extract<RealBlockedByEntry, { type: T }> extends Extract<
    AdminBlockedByEntry,
    { type: T }
  >
    ? true
    : [
        "admin BlockedByEntry variant for type",
        T,
        "is not assignable from task-store's real shape",
      ];

type _AssertHitlAssignable = AssertVariantAssignable<"hitl">;
const _assertHitlAssignable: _AssertHitlAssignable = true;
void _assertHitlAssignable;

type _AssertDependencyAssignable = AssertVariantAssignable<"dependency">;
const _assertDependencyAssignable: _AssertDependencyAssignable = true;
void _assertDependencyAssignable;

type _AssertBlockedAssignable = AssertVariantAssignable<"blocked">;
const _assertBlockedAssignable: _AssertBlockedAssignable = true;
void _assertBlockedAssignable;

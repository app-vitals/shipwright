/**
 * task-store/src/session-plan-service.ts
 * SessionPlanService — POST /sessions/{slug}/plan (PWE-3.1).
 *
 * One call for what plan-session used to do in three (register the plan
 * document, POST /tasks/bulk, then mark each spec planned), all inside ONE
 * transaction:
 *
 *   1. ensure the [accountId, slug] Session row;
 *   2. respect the planning lock — a live lock held by another holder is a
 *      409 (same body as POST /sessions/{slug}/lock). The check is a
 *      conditional UPDATE, so it row-locks the session for the rest of the
 *      transaction and a concurrent acquire waits for this write to finish;
 *   3. for agent tokens, every repo the session already spans (task repos,
 *      document home and target repos) must be in scope;
 *   4. register the plan document (number 1, idempotent) — this also sets
 *      the session's owner (first one wins) and homeRepo (when empty), the
 *      same way POST /documents does;
 *   5. set plannedAt on the listed specs (left untouched when already set);
 *   6. create the tasks stamped with planDocumentId, originKind=document and
 *      originRef=<plan document id> via TaskService.bulk() on the same
 *      transaction client. This runs last, so the single task.write webhook
 *      fires only after every other write has landed.
 *
 * Any throw — a task id collision (409), an unknown spec (400), a scope
 * failure (403) or a webhook delivery failure (502) — rolls back everything,
 * including the session row and the plan document.
 *
 * The repos named by the request itself (plan repo, plan.repos, task repos)
 * are scope-checked before the transaction opens. Task payload validation
 * (status, repo format, field types, accountId stamping) is the route's job,
 * shared with POST /tasks/bulk.
 */

import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";
import type { DocumentServiceLike } from "./document-service.ts";
import { BadRequestError, ForbiddenError } from "./errors.ts";
import type { Prisma, PrismaClient } from "./index.ts";
import {
  isBlankSession,
  planningLockFreeTo,
  planningLockHeldError,
} from "./session-service.ts";
import {
  type BulkTxClient,
  bulkTxTimeoutMs,
  MAX_BULK_TASKS,
  type TaskServiceLike,
} from "./task-service.ts";

export interface SessionPlanDocumentInput {
  /** The session's home repo (org/repo) the plan file lives in. */
  repo: string;
  path: string;
  title?: string | null;
  owner?: string | null;
  /** Target repos. */
  repos?: string[];
}

export interface SessionPlanInput {
  session: string;
  accountId: string;
  /** Planning-lock identity; a live lock held by anyone else is a 409. */
  holder: string;
  plan: SessionPlanDocumentInput;
  /** Already validated and accountId-stamped (see routes/tasks.ts). */
  tasks: Prisma.TaskCreateInput[];
  /** Spec numbers to mark planned. */
  specs: number[];
}

export interface SessionPlanResult {
  planDocumentId: string;
  inserted: number;
}

/** Caller scope: `repos: null` = admin = unrestricted. */
export interface SessionPlanScope {
  repos: string[] | null;
}

export interface SessionPlanServiceLike {
  plan(
    input: SessionPlanInput,
    scope: SessionPlanScope,
  ): Promise<SessionPlanResult>;
}

/** The repos the request itself names: plan home + targets + every task repo. */
export function requestRepos(
  plan: SessionPlanDocumentInput,
  tasks: { repo?: unknown }[],
): string[] {
  const repos = new Set<string>([plan.repo, ...(plan.repos ?? [])]);
  for (const t of tasks) {
    if (typeof t.repo === "string") repos.add(t.repo);
  }
  return [...repos];
}

export class SessionPlanService implements SessionPlanServiceLike {
  constructor(
    private prisma: PrismaClient,
    private taskService: Pick<TaskServiceLike, "bulk">,
    private documentService: Pick<DocumentServiceLike, "register">,
    private clock: Clock = SystemClock(),
  ) {}

  async plan(
    input: SessionPlanInput,
    scope: SessionPlanScope,
  ): Promise<SessionPlanResult> {
    const slug = input.session;
    if (isBlankSession(slug)) throw new BadRequestError("session is required");
    if (input.tasks.length > MAX_BULK_TASKS) {
      throw new BadRequestError(
        `a plan accepts at most ${MAX_BULK_TASKS} tasks per call (received ${input.tasks.length}) — split the batch`,
      );
    }
    if (scope.repos !== null) {
      const allowed = scope.repos;
      const outside = requestRepos(input.plan, input.tasks).filter(
        (r) => !allowed.includes(r),
      );
      if (outside.length > 0) {
        throw new ForbiddenError(
          `repos outside this token's scope: ${outside.join(", ")}`,
        );
      }
    }
    const specs = [...new Set(input.specs)];
    const { accountId } = input;

    return this.prisma.$transaction(
      async (tx) => {
        const now = this.clock.now();

        // 1. Session row (race-safe ON CONFLICT DO NOTHING, as in
        // SessionService.upsert / DocumentService.register).
        await tx.session.createMany({
          data: [{ slug, accountId }],
          skipDuplicates: true,
        });

        // 2. Planning lock. The conditional UPDATE both checks the lock and
        // row-locks the session until this transaction ends.
        const { count } = await tx.session.updateMany({
          where: { accountId, slug, ...planningLockFreeTo(input.holder, now) },
          data: { updatedAt: now },
        });
        if (count === 0) {
          const row = await tx.session.findUniqueOrThrow({
            where: { accountId_slug: { accountId, slug } },
          });
          throw planningLockHeldError(row);
        }

        // 3. The session's existing repos must be in an agent's scope too.
        if (scope.repos !== null) {
          await this.assertSessionInScope(tx, slug, accountId, scope.repos);
        }

        // 4. Plan document (idempotent on [accountId, session, plan, 1]).
        const doc = await this.documentService.register(
          {
            session: slug,
            kind: "plan",
            repo: input.plan.repo,
            path: input.plan.path,
            title: input.plan.title,
            owner: input.plan.owner,
            repos: input.plan.repos,
          },
          accountId,
          { repos: scope.repos, accountId },
          tx,
        );

        // 5. Specs planned.
        for (const number of specs) {
          const spec = await tx.planDocument.findUnique({
            where: {
              accountId_session_kind_number: {
                accountId,
                session: slug,
                kind: "spec",
                number,
              },
            },
            select: { id: true },
          });
          if (!spec) {
            throw new BadRequestError(
              `spec ${number} is not registered in session '${slug}'`,
            );
          }
          await tx.planDocument.updateMany({
            where: { id: spec.id, plannedAt: null },
            data: { plannedAt: now },
          });
        }

        // 6. Tasks, stamped with the plan document, last.
        let inserted = 0;
        if (input.tasks.length > 0) {
          const stamped = input.tasks.map((t) => ({
            ...t,
            session: slug,
            planDocumentId: doc.id,
            originKind: "document",
            originRef: doc.id,
          }));
          ({ inserted } = await this.taskService.bulk(
            stamped,
            tx as BulkTxClient,
          ));
        }
        return { planDocumentId: doc.id, inserted };
      },
      { timeout: bulkTxTimeoutMs(input.tasks.length) },
    );
  }

  /**
   * Same all-repos rule as PATCH /sessions/{slug} (PWE-1.1), applied to what
   * the session already holds. Names no repo: the caller may not be able to
   * see the session.
   */
  private async assertSessionInScope(
    tx: Prisma.TransactionClient,
    slug: string,
    accountId: string,
    scope: string[],
  ): Promise<void> {
    // Sequential: an interactive transaction runs on one connection.
    const tasks = await tx.task.findMany({
      where: { accountId, session: slug, repo: { not: null } },
      select: { repo: true },
      distinct: ["repo"],
    });
    const docs = await tx.planDocument.findMany({
      where: { accountId, session: slug },
      select: { repo: true, repos: true },
    });
    const repos = new Set<string>();
    for (const t of tasks) if (t.repo) repos.add(t.repo);
    for (const d of docs) {
      repos.add(d.repo);
      for (const r of d.repos) repos.add(r);
    }
    if ([...repos].some((r) => !scope.includes(r))) {
      throw new ForbiddenError(
        "session spans repos outside this token's scope",
      );
    }
  }
}

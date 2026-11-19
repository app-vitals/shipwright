/**
 * task-store/src/document-service.ts
 * DocumentService — registers, lists and patches planning documents (PLU-2.2).
 *
 * A PlanDocument is one numbered spec (or the session's single plan) living as
 * a file in the session's home repo, keyed by [accountId, session, kind,
 * number]. register() is idempotent on that key: re-registering updates the
 * mutable fields (prUrl, title, owner, repos, state, ...) on the one row.
 *
 * register() also ensures the [accountId, session] Session row exists (until
 * now sessions were created only as a side effect of task writes), sets the
 * session's `owner` from the FIRST document that carries one — never
 * overwritten afterwards — and sets `homeRepo` when empty. Both are
 * conditional UPDATEs (`WHERE owner IS NULL`) so concurrent first
 * registrations cannot overwrite each other.
 *
 * Scope: registering requires the document's home repo to be in the caller's
 * repo scope (`repos: null` = admin = unrestricted). Reads (list) show a
 * document when its home repo OR any target repo is in the token's scope
 * (PLU-2.3); patches keep the stricter home-repo rule. Anything outside the
 * scope behaves as not-found.
 */

import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";
import type {
  PlanDocument,
  PlanDocumentKind,
  PlanDocumentState,
  Prisma,
  PrismaClient,
} from "./index.ts";
import { isBlankSession } from "./session-service.ts";

/** Caller scope. `repos: null` = unrestricted (admin); `accountId: null` = no account restriction. */
export interface DocumentScope {
  repos: string[] | null;
  accountId: string | null;
}

export interface RegisterDocumentInput {
  session: string;
  kind: PlanDocumentKind;
  /** Required for specs; plans are always 1. */
  number?: number;
  repo: string;
  path: string;
  title?: string | null;
  owner?: string | null;
  repos?: string[];
  prUrl?: string | null;
  state?: PlanDocumentState;
  commitSha?: string | null;
  originTaskId?: string | null;
}

export interface PatchDocumentInput {
  /** ISO timestamp, or null to clear. */
  plannedAt?: string | null;
  prUrl?: string | null;
  owner?: string | null;
  state?: PlanDocumentState;
}

export interface DocumentListFilters {
  session?: string;
  kind?: PlanDocumentKind;
  owner?: string;
  planned?: boolean;
}

/**
 * The client surface register() writes through. Satisfied by a
 * `$transaction` callback's `tx`, so a caller can register a document inside
 * its own transaction (PWE-3.1, POST /sessions/{slug}/plan).
 */
export type DocumentTxClient = Pick<
  Prisma.TransactionClient,
  "session" | "planDocument"
>;

/** The subset of DocumentService the routes depend on. */
export interface DocumentServiceLike {
  register(
    input: RegisterDocumentInput,
    accountId: string,
    scope: DocumentScope,
    tx?: DocumentTxClient,
  ): Promise<PlanDocument>;
  list(
    filters: DocumentListFilters,
    scope: DocumentScope,
  ): Promise<{ documents: PlanDocument[]; total: number }>;
  patch(
    id: string,
    patch: PatchDocumentInput,
    scope: DocumentScope,
  ): Promise<PlanDocument>;
}

/** Only defined keys: `undefined` means "leave untouched" on re-registration. */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export class DocumentService implements DocumentServiceLike {
  constructor(private prisma: PrismaClient) {}

  /**
   * Pass `tx` to run inside a caller-owned transaction (PWE-3.1): no
   * transaction is opened here and a throw rolls back the caller's whole
   * transaction. Without it, register() runs in its own transaction.
   */
  async register(
    input: RegisterDocumentInput,
    accountId: string = DEFAULT_ACCOUNT_ID,
    scope: DocumentScope = { repos: null, accountId: null },
    tx?: DocumentTxClient,
  ): Promise<PlanDocument> {
    if (isBlankSession(input.session)) {
      throw new BadRequestError("session is required");
    }
    if (!input.repo) throw new BadRequestError("repo is required");
    if (!input.path) throw new BadRequestError("path is required");
    if (scope.repos !== null && !scope.repos.includes(input.repo)) {
      throw new ForbiddenError(
        `repo '${input.repo}' is not in the token's repo scope`,
      );
    }

    let number: number;
    if (input.kind === "plan") {
      if (input.number !== undefined && input.number !== 1) {
        throw new BadRequestError("a plan's number is always 1");
      }
      number = 1;
    } else {
      if (input.number === undefined) {
        throw new BadRequestError("number is required for a spec");
      }
      number = input.number;
    }

    const slug = input.session;
    const mutable = definedOnly({
      repo: input.repo,
      path: input.path,
      title: input.title,
      owner: input.owner,
      repos: input.repos,
      prUrl: input.prUrl,
      state: input.state,
      commitSha: input.commitSha,
      originTaskId: input.originTaskId,
    });

    const write = async (tx: DocumentTxClient): Promise<PlanDocument> => {
      // The upsert below rewrites `repo` on an existing row, so a scoped token
      // must also own the existing document — otherwise it could overwrite and
      // re-home another repo's row. Checked before any write so an
      // out-of-scope key mutates nothing. The message does not name the owner.
      if (scope.repos !== null) {
        const existing = await tx.planDocument.findUnique({
          where: {
            accountId_session_kind_number: {
              accountId,
              session: slug,
              kind: input.kind,
              number,
            },
          },
          select: { repo: true },
        });
        if (existing && !scope.repos.includes(existing.repo)) {
          throw new ForbiddenError(
            "document is owned by a repo outside the token's repo scope",
          );
        }
      }

      // Ensure the session row — target-less ON CONFLICT DO NOTHING, same
      // race-safe shape as SessionService.upsert().
      await tx.session.createMany({
        data: [{ slug, accountId }],
        skipDuplicates: true,
      });
      if (input.owner) {
        await tx.session.updateMany({
          where: { accountId, slug, owner: null },
          data: { owner: input.owner },
        });
      }
      await tx.session.updateMany({
        where: { accountId, slug, homeRepo: null },
        data: { homeRepo: input.repo },
      });

      return tx.planDocument.upsert({
        where: {
          accountId_session_kind_number: {
            accountId,
            session: slug,
            kind: input.kind,
            number,
          },
        },
        create: {
          accountId,
          session: slug,
          kind: input.kind,
          number,
          ...mutable,
        } as never,
        update: mutable,
      });
    };
    return tx ? write(tx) : this.prisma.$transaction(write);
  }

  async list(
    filters: DocumentListFilters = {},
    scope: DocumentScope = { repos: null, accountId: null },
  ): Promise<{ documents: PlanDocument[]; total: number }> {
    const and: object[] = [];
    if (scope.accountId !== null) and.push({ accountId: scope.accountId });
    if (scope.repos !== null) {
      // PLU-2.3: visible through the home repo OR any target repo.
      and.push({
        OR: [
          { repo: { in: scope.repos } },
          { repos: { hasSome: scope.repos } },
        ],
      });
    }
    if (filters.session !== undefined) and.push({ session: filters.session });
    if (filters.kind !== undefined) and.push({ kind: filters.kind });
    if (filters.owner !== undefined) and.push({ owner: filters.owner });
    if (filters.planned === false) {
      // Unplanned = specs not yet consumed by a planning pass and not abandoned.
      and.push({
        kind: "spec",
        plannedAt: null,
        state: { not: "abandoned" },
      });
    } else if (filters.planned === true) {
      and.push({ plannedAt: { not: null } });
    }
    const where = and.length ? { AND: and } : {};
    const documents = await this.prisma.planDocument.findMany({
      where,
      orderBy: [{ session: "asc" }, { kind: "asc" }, { number: "asc" }],
    });
    return { documents, total: documents.length };
  }

  async patch(
    id: string,
    patch: PatchDocumentInput,
    scope: DocumentScope = { repos: null, accountId: null },
  ): Promise<PlanDocument> {
    const existing = await this.prisma.planDocument.findUnique({
      where: { id },
    });
    if (
      !existing ||
      (scope.accountId !== null && existing.accountId !== scope.accountId) ||
      (scope.repos !== null && !scope.repos.includes(existing.repo))
    ) {
      throw new NotFoundError("document not found");
    }
    if (
      patch.plannedAt !== undefined &&
      patch.plannedAt !== null &&
      existing.kind !== "spec"
    ) {
      throw new BadRequestError("plannedAt applies to specs only");
    }
    return this.prisma.planDocument.update({
      where: { id },
      data: definedOnly({
        plannedAt:
          patch.plannedAt === undefined
            ? undefined
            : patch.plannedAt === null
              ? null
              : new Date(patch.plannedAt),
        prUrl: patch.prUrl,
        owner: patch.owner,
        state: patch.state,
      }),
    });
  }
}

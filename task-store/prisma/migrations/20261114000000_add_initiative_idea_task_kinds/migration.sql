-- INI-1.1: additive only — new `initiative` and `idea` task kinds.
-- Neither is ever part of the ready set (see ready.ts).

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'initiative';

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'idea';

/**
 * admin/src/coding-admin-extension.ts
 *
 * Shipwright's coding AdminExtension: the home for the coding agent's admin
 * surfaces (task-store views, dev-task adherence, work queue, sessions). It
 * registers nothing yet — those surfaces still live in the platform and move
 * here in later tasks — so the admin main.ts composes is the bare platform.
 */

import type { AdminExtension } from "./admin-extension.ts";

export const codingAdminExtension: AdminExtension = { name: "coding" };

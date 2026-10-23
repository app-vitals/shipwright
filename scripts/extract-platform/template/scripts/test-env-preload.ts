/**
 * Test-run environment, loaded by bunfig.toml's `preload` before any test file.
 *
 * Forces NODE_ENV=test and points the specialty lookup at the minimal fixture
 * specialty under runtime/fixtures/, so the suite needs no product specialty
 * and no product workspace templates. Values already set in the environment
 * win, so a developer can still aim a run at a real specialties directory.
 */

import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.SHIPWRIGHT_SPECIALTIES_DIR ||= join(
  import.meta.dir,
  "..",
  "runtime",
  "fixtures",
  "specialties",
);
process.env.SHIPWRIGHT_DEFAULT_AGENT_TYPE ||= "fixture";

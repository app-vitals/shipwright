import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";
import { defineConfig } from "astro/config";

// Shipwright Harness marketing site — static (SSG), Vercel target, dark-premium.
export default defineConfig({
  site: "https://shipwrightharness.com",
  integrations: [tailwind(), sitemap()],
  output: "static",
});

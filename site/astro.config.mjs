import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";
import { defineConfig } from "astro/config";

// Shipwright Harness marketing site — static (SSG), GitHub Pages, dark-premium.
export default defineConfig({
  site: "https://shipwrightharness.com",
  integrations: [tailwind(), sitemap(), mdx()],
  output: "static",
  markdown: {
    shikiConfig: {
      // Use css-variables theme so syntax colors map to brand tokens
      // via --astro-code-* CSS variables defined in brand.css.
      theme: "css-variables",
    },
  },
});

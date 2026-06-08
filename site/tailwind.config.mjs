/** @type {import('tailwindcss').Config} */
// Colors + fonts mirror brand/tokens.json (single source of truth).
// CSS variables live in src/styles/brand.css; these utilities expose the same
// values to Tailwind classes. Keep hex values in sync with brand/tokens.json.
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        // Navy bases
        navy: {
          base: "#080E1E",
          raised: "#0F172A",
          overlay: "#1E293B",
        },
        border: {
          subtle: "#1E293B",
          muted: "#334155",
          strong: "#475569",
        },
        // Ship-green hero accent
        brand: {
          DEFAULT: "#34C77B",
          strong: "#2BAE6E",
          soft: "#0F2D1E",
        },
        // Patriot blue support
        support: {
          patriot: "#002244",
          "patriot-bright": "#4F8EF7",
          cyan: "#22D3EE",
          violet: "#8B5CF6",
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        body: ['"General Sans"', '"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      maxWidth: {
        container: "72rem",
      },
    },
  },
  plugins: [],
};

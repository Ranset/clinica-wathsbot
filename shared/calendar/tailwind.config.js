/** Tema propio de la clinica (los nombres semanticos coinciden con los que usan los componentes). */
const v = (n) => `var(--${n})`;
const tint = (n) => ({ DEFAULT: v(n), tint: v(`${n}-tint`), soft: v(`${n}-soft`), text: v(`${n}-text`) });

export default {
  content: ["./src/**/*.{ts,tsx}", "./demo/**/*.{ts,tsx,html}", "../../doctor-pwa/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: v("border"),
        "border-strong": v("border-strong"),
        input: v("border-strong"),
        ring: v("ring"),
        background: v("bg"),
        foreground: v("text"),
        subtle: v("bg-subtle"),
        card: { DEFAULT: v("bg"), foreground: v("text") },
        primary: { DEFAULT: v("accent"), foreground: v("accent-fg") },
        secondary: { DEFAULT: v("bg-panel"), foreground: v("text-2") },
        muted: { DEFAULT: v("bg-panel"), foreground: v("text-3") },
        accent: { DEFAULT: v("bg-hover"), foreground: v("text") },
        brand: {
          DEFAULT: v("accent"),
          hover: v("accent-hover"),
          soft: v("accent-soft"),
          tint: v("accent-tint"),
          text: v("accent-text"),
          fg: v("accent-fg"),
        },
        "text-2": v("text-2"),
        "text-3": v("text-3"),
        "text-4": v("text-4"),
        "row-hover": v("row-hover"),
        success: tint("success"),
        warning: tint("warning"),
        danger: tint("danger"),
      },
      borderRadius: { sm: "4px", md: "8px", lg: "12px" },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
};

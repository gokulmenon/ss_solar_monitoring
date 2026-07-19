import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./tests/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      boxShadow: {
        glowGreen: "0 0 24px rgba(34, 197, 94, 0.35)",
        glowRed: "0 0 24px rgba(248, 113, 113, 0.35)",
        glowAmber: "0 0 24px rgba(251, 191, 36, 0.25)",
      },
      colors: {
        solar: {
          50: "#fefce8",
          100: "#fef9c3",
          200: "#fef08a",
          300: "#fde047",
          400: "#facc15",
          500: "#eab308",
          600: "#ca8a04",
          700: "#a16207",
          800: "#854d0e",
          900: "#713f12",
        },
      },
    },
  },
  plugins: [],
};

export default config;

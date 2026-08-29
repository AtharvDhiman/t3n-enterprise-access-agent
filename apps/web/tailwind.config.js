/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7f9", 100: "#eceef2", 200: "#d5d9e2", 300: "#b0b8c9",
          400: "#8590a9", 500: "#65718d", 600: "#505a74", 700: "#42495e",
          800: "#393f50", 900: "#151823", 950: "#0d0f17",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

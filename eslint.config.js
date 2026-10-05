import js from "@eslint/js";
import globals from "globals";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default [
  { ignores: ["vendor/**", "node_modules/**", "supabase/**"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, supabase: "readonly", XLSX: "readonly", turnstile: "readonly" },
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Daftar kerja XSS: setiap innerHTML dengan interpolasi harus lewat
      // esc()/escapeHtml(). Dibiarkan "warn" karena ada ±300 titik lama.
      "no-unsanitized/property": ["warn", {
        escape: { methods: ["esc", "escapeHtml", "escapeAttr", "escMsg"] },
      }],
    },
  },
  { files: ["sw.js"], languageOptions: { sourceType: "script", globals: globals.serviceworker } },
];

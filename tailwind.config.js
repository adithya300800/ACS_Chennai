/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      colors: {
        acsblue: "#2563eb",
        acsdark: "#111827"
      }
    }
  },
  plugins: []
};
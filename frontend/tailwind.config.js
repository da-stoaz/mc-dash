const { heroui } = require('@heroui/theme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx,mjs}',
    './node_modules/@heroui/react/**/*.{js,ts,jsx,tsx,mjs}',
  ],
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [heroui()],
};

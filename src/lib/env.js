// Centralized env-var reads. All `import.meta.env` access lives here so
// that:
//
//   1. We have ONE place to mock in tests (see moduleNameMapper in
//      package.json → jest.moduleNameMapper) instead of N files all using
//      import.meta directly.
//   2. If we ever swap Vite for another bundler, we change one file.
//
// In Vite (production + dev), `import.meta.env.VITE_API_URL` is inlined
// at build time. In Jest, the `^.*/lib/env\\.js$` moduleNameMapper rule
// points this module to a CJS stub that reads process.env instead.

export const VITE_API_URL = import.meta.env.VITE_API_URL || '';

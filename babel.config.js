module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
  // Note: `import.meta.env` is isolated in src/lib/env.js so this file
  // doesn't need a transform plugin. The Jest moduleNameMapper redirects
  // env.js to a CJS stub at test time (see package.json).
};

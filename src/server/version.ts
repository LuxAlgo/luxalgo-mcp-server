/*
  The identity every entry announces in `initialize` (serverInfo). The
  version is written here by hand rather than read from package.json at
  runtime so the module stays a plain import on every host (Vercel's bundler
  included); `npm test` asserts it matches package.json, so a release bump
  that forgets this file fails CI instead of shipping a stale version.
*/
export const SERVER_NAME = "luxalgo";
export const SERVER_VERSION = "1.5.0";

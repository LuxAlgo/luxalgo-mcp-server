/*
  Compatibility shim: `node dist/http.js` was the documented way to run the
  plain-Node HTTP entry through 1.4.x. The entry now lives in
  entries/node-http.ts (`npm run start:http`); this import keeps existing
  process managers working.
*/
import "./entries/node-http.js";

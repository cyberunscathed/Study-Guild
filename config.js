// =========================================================
// QUESTBOARD CONFIG
// Firebase's web config is safe to keep here — it's meant to be
// public; Firestore security rules (see README.md) are what
// actually protect your data, not hiding this object.
//
// The Gemini API key is NOT here anymore. Gemini calls now go
// through a Cloudflare Worker (study-guild.pratap-ram-varma.workers.dev)
// that holds the key server-side as a Worker secret, so it never
// ships to the browser. See worker.js and the README for setup.
// =========================================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDl56ZwcySQ5HX9Zt5L_FDKI3FdVUSCc_0",
  authDomain: "study-guild-cc2c8.firebaseapp.com",
  projectId: "study-guild-cc2c8",
  storageBucket: "study-guild-cc2c8.firebasestorage.app",
  messagingSenderId: "135029279561",
  appId: "1:135029279561:web:c1eefbc344c30b8108e898",
  measurementId: "G-BECTGT54Z1"
};

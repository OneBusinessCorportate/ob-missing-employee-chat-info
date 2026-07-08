// Minimal Express web service:
//   GET /            -> the dashboard (static, mobile-friendly)
//   GET /api/problem-chats -> JSON list of problematic chats + counts
//   GET /healthz     -> health check for Render
//
// The Supabase service role key stays on the server; the browser only ever
// talks to /api/problem-chats.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProblemChats } from "./lib/problemChats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/problem-chats", async (_req, res) => {
  try {
    const { problems, counts } = await getProblemChats();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, counts, chats: problems });
  } catch (err) {
    console.error("[/api/problem-chats]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});

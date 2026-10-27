// Box import and morning email status and actions.
import type { Express } from "express";
import { buildDigest, sendDigest, digestStatus, clearDigestError } from "../digest";
import { storage } from "../storage";
import { runBoxImport, boxStatus, boxConfig, boxRunning } from "../box";

export function registerIntegrationRoutes(app: Express) {
  // ── Box import ─────────────────────────────────────────────────────
  app.get("/api/box/status", (_req, res) => res.json(boxStatus()));
  app.get("/api/box/files", (_req, res) => res.json(storage.getBoxFiles()));
  app.post("/api/box/run", (_req, res) => {
    const cfg = boxConfig();
    if (!cfg.configured) return res.status(400).json({ message: `Box import isn't set up. Add ${cfg.missing.join(", ")} in Railway.` });
    const already = boxRunning();
    runBoxImport("manual"); // runs in the background; the Overview card follows /api/box/status
    res.status(202).json({ started: !already, running: true });
  });
  // Try a failed file again on the next run.
  app.post("/api/box/files/:id/retry", (req, res) => {
    const f = storage.getBoxFiles().find(x => x.id === Number(req.params.id));
    if (!f) return res.status(404).json({ message: "Not found" });
    if (f.status !== "failed") return res.status(400).json({ message: "Only failed files can be tried again." });
    storage.deleteBoxFile(f.id);
    res.json({ ok: true });
  });

  // ── Morning email ──────────────────────────────────────────────────
  app.get("/api/digest/status", (_req, res) => res.json(digestStatus()));
  app.get("/api/digest/preview", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildDigest().html);
  });
  app.post("/api/digest/test", async (_req, res) => {
    try {
      const r = await sendDigest({ test: true });
      clearDigestError();
      res.json({ ok: true, to: r.to });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });
}

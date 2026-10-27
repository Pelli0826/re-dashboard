import type { Express } from "express";
import type { Server } from "http";
import { configureBoxImport } from "./box";
import { createDeal } from "./deals";
import { registerAuthRoutes, requireAuth } from "./api/auth";
import { registerRecordRoutes } from "./api/records";
import { registerPipelineRoutes } from "./api/pipeline";
import { registerUnderwritingRoutes } from "./api/underwriting";
import { registerDealFileRoutes } from "./api/dealFiles";
import { registerAskRoutes } from "./api/ask";
import { registerIntegrationRoutes } from "./api/integrations";

// All API routes. Each area lives in server/api/; deal logic shared between them is in server/deals.ts.
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  registerAuthRoutes(app);

  // Apply auth middleware to all remaining /api routes
  app.use("/api", requireAuth);

  registerRecordRoutes(app);
  registerPipelineRoutes(app);
  registerUnderwritingRoutes(app);
  registerDealFileRoutes(app);
  registerAskRoutes(app);
  registerIntegrationRoutes(app);
  configureBoxImport({ createDeal });

  // Unknown API paths get a JSON 404 instead of falling through to the web app.
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));

  return httpServer;
}

// Small helpers shared by the API route files.
import { z } from "zod";

export const todayYmd = () => new Date().toISOString().slice(0, 10);
export const maxYmd = (a: string, b: string) => (a > b ? a : b);

// Turn zod errors into one readable line, e.g. "stage: Invalid option".
export function readable(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

import { useState } from "react";
import type { PipelineDeal } from "@shared/schema";
import { DEAD_REASONS } from "@shared/pipeline";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// ── Mark dead ───────────────────────────────────────────────────────────────
export function DeadReasonDialog({ deal, onClose, onConfirm }: { deal: PipelineDeal | null; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState<string>("Pricing");
  const [detail, setDetail] = useState("");
  return (
    <Dialog open={!!deal} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {deal?.name} dead</DialogTitle>
          <DialogDescription>The reason is kept with the deal so you can see later why deals fell out.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{DEAD_REASONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dead-detail">Details (optional)</Label>
            <Textarea id="dead-detail" rows={3} value={detail} onChange={e => setDetail(e.target.value)} placeholder="e.g. Seller would not go below $4.2M" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => { onConfirm(detail.trim() ? `${reason}: ${detail.trim()}` : reason); setDetail(""); }}>Mark dead</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

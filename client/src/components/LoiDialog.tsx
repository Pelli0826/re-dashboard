import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, DealFile } from "@shared/schema";
import { dollarsInWords, countInWords, type LoiTerms } from "@shared/loi";
import { Loader2, Plus, Trash2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// "400: {"message":"..."}" → "..."
function errorText(e: Error): string {
  const body = e.message.replace(/^\d+:\s*/, "");
  try { return JSON.parse(body).message ?? body; } catch { return body; }
}

const money = (s: string) => Number(s.replace(/[^0-9.]/g, "")) || 0;
const whole = (s: string) => Math.max(0, Math.round(Number(s) || 0));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-foreground pb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function LoiDialog({ deal, open, onClose }: { deal: PipelineDeal; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ["/api/pipeline", deal.id, "loi"];
  const { data, isLoading } = useQuery<{ terms: LoiTerms; saved: boolean }>({ queryKey: key, enabled: open, staleTime: 0 });
  const [t, setT] = useState<LoiTerms | null>(null);
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (open && data) { setT(data.terms); setPrice(data.terms.price ? data.terms.price.toLocaleString("en-US") : ""); }
    if (!open) setT(null);
  }, [open, data]);

  const set = <K extends keyof LoiTerms>(k: K, v: LoiTerms[K]) => setT(prev => prev ? { ...prev, [k]: v } : prev);
  const terms = (): LoiTerms => ({ ...t!, price: money(price) });

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/pipeline/${deal.id}/loi`, terms())).json(),
    onSuccess: res => { qc.setQueryData(key, res); toast({ title: "LOI terms saved" }); },
    onError: (e: Error) => toast({ title: "Could not save", description: errorText(e), variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/pipeline/${deal.id}/loi`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const draft = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/pipeline/${deal.id}/loi/draft`, terms())).json() as Promise<DealFile>,
    onSuccess: f => {
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "files"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "activity"] });
      qc.invalidateQueries({ queryKey: key });
      toast({ title: "LOI draft created", description: `Saved to Files as ${f.name}. Review and edit it in Word before sending.` });
      window.location.href = `/api/files/${f.id}/download`;
      onClose();
    },
    onError: (e: Error) => toast({ title: "Could not create the LOI", description: errorText(e), variant: "destructive" }),
  });

  const busy = save.isPending || draft.isPending || reset.isPending;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileText size={16} /> Letter of intent</DialogTitle>
          <DialogDescription>
            Filled in from the deal. Change anything, then create a Word draft. It's saved to the deal's files for you to review and send yourself.
          </DialogDescription>
        </DialogHeader>

        {(isLoading || !t) ? (
          <div className="py-10 flex justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : (
          <form className="space-y-6" onSubmit={e => { e.preventDefault(); draft.mutate(); }}>
            <Section title="Recipient">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label htmlFor="loi-rn">Name</Label><Input id="loi-rn" value={t.recipientName} onChange={e => set("recipientName", e.target.value)} placeholder="Usually the listing broker" /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-rc">Company</Label><Input id="loi-rc" value={t.recipientCompany} onChange={e => set("recipientCompany", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-re">Email</Label><Input id="loi-re" value={t.recipientEmail} onChange={e => set("recipientEmail", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-date">Letter date</Label><Input id="loi-date" type="date" value={t.date} onChange={e => set("date", e.target.value)} /></div>
              </div>
            </Section>

            <Section title="Property and parties">
              <div className="space-y-1.5">
                <Label htmlFor="loi-prop">Property</Label>
                <Textarea id="loi-prop" rows={2} value={t.property} onChange={e => set("property", e.target.value)} />
                <Hint>Reads as: "Letter of Intent to Purchase {t.property || "…"} (the "Property")". Add parcel numbers or zoning if you want them in the letter.</Hint>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label htmlFor="loi-seller">Seller</Label><Input id="loi-seller" value={t.seller} onChange={e => set("seller", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-buyer">Buyer</Label><Input id="loi-buyer" value={t.buyer} onChange={e => set("buyer", e.target.value)} /></div>
              </div>
            </Section>

            <Section title="Price and deposits">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="loi-price">Purchase price ($)</Label>
                  <Input id="loi-price" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value)}
                    onBlur={() => setPrice(money(price) ? money(price).toLocaleString("en-US") : "")} />
                </div>
                <div className="space-y-1.5"><Label htmlFor="loi-terms">Terms</Label><Input id="loi-terms" value={t.paymentTerms} onChange={e => set("paymentTerms", e.target.value)} placeholder="Leave blank to leave out" /></div>
              </div>
              {money(price) > 0 && <Hint>In the letter: {dollarsInWords(money(price))}</Hint>}
              <div className="space-y-2">
                {t.deposits.map((d, i) => (
                  <div key={i} className="rounded-md border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`loi-dep-${i}`} className="w-28 shrink-0">{t.deposits.length > 1 ? `Deposit ${i + 1} ($)` : "Deposit ($)"}</Label>
                      <Input id={`loi-dep-${i}`} inputMode="numeric" value={d.amount ? d.amount.toLocaleString("en-US") : ""}
                        onChange={e => set("deposits", t.deposits.map((x, j) => j === i ? { ...x, amount: money(e.target.value) } : x))} />
                      <button type="button" aria-label={`Remove deposit ${i + 1}`} className="p-1 text-muted-foreground hover:text-destructive"
                        onClick={() => set("deposits", t.deposits.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                    </div>
                    <Textarea rows={2} aria-label={`When deposit ${i + 1} is due`} value={d.when}
                      onChange={e => set("deposits", t.deposits.map((x, j) => j === i ? { ...x, when: e.target.value } : x))} />
                  </div>
                ))}
                {t.deposits.length < 6 && (
                  <Button type="button" size="sm" variant="ghost" className="gap-1 h-7"
                    onClick={() => set("deposits", [...t.deposits, { amount: 100000, when: "at the expiration of the Investigation Period" }])}>
                    <Plus size={13} /> Add deposit
                  </Button>
                )}
              </div>
            </Section>

            <Section title="Timing">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5"><Label htmlFor="loi-inv">Investigation period (days)</Label><Input id="loi-inv" type="number" min={1} value={t.investigationDays} onChange={e => set("investigationDays", whole(e.target.value))} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-cd">Settlement (days after)</Label><Input id="loi-cd" type="number" min={0} value={t.closingDays} onChange={e => set("closingDays", whole(e.target.value))} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-exp">LOI open for (business days)</Label><Input id="loi-exp" type="number" min={1} value={t.expirationDays} onChange={e => set("expirationDays", whole(e.target.value))} /></div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loi-ca">Settlement counts from</Label>
                <Input id="loi-ca" value={t.closingAfter} onChange={e => set("closingAfter", e.target.value)} />
                <Hint>In the letter: Settlement shall occur {countInWords(t.closingDays)} days after {t.closingAfter || "…"}.</Hint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loi-appr">Approval period</Label>
                <Textarea id="loi-appr" rows={4} value={t.approvals} onChange={e => set("approvals", e.target.value)} placeholder="For land deals: zoning and plan approvals and how long Buyer has. Leave blank to leave out." />
              </div>
            </Section>

            <Section title="Other terms">
              <div className="space-y-1.5"><Label htmlFor="loi-brok">Brokerage</Label><Textarea id="loi-brok" rows={3} value={t.brokerage} onChange={e => set("brokerage", e.target.value)} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5"><Label htmlFor="loi-ex">Exclusivity (months, 0 to leave out)</Label><Input id="loi-ex" type="number" min={0} value={t.exclusivityMonths} onChange={e => set("exclusivityMonths", whole(e.target.value))} /></div>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <Switch checked={t.prorations} onCheckedChange={v => set("prorations", v)} aria-label="Include closing pro-rations" />
                  Include rent and tax pro-rations (income properties)
                </label>
              </div>
            </Section>

            <Section title="Signed by">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5"><Label htmlFor="loi-sn">Name</Label><Input id="loi-sn" value={t.signerName} onChange={e => set("signerName", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-st">Title</Label><Input id="loi-st" value={t.signerTitle} onChange={e => set("signerTitle", e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="loi-sp">Phone</Label><Input id="loi-sp" value={t.signerPhone} onChange={e => set("signerPhone", e.target.value)} /></div>
              </div>
            </Section>

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
              {data?.saved && (
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => reset.mutate()}>
                  Start over from deal
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button type="button" variant="outline" onClick={() => save.mutate()} disabled={busy}>Save terms</Button>
                <Button type="submit" disabled={busy || !money(price)}>
                  {draft.isPending && <Loader2 size={13} className="animate-spin mr-1" />} Create Word draft
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

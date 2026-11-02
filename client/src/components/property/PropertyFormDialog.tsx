// Add or edit an owned property.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Property } from "@shared/schema";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS } from "@shared/properties";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export function errorText(e: Error): string {
  const body = e.message.replace(/^\d+:\s*/, "");
  try { return JSON.parse(body).message ?? body; } catch { return body; }
}

type F = Record<string, string>;
const toForm = (p: Property | null): F => ({
  name: p?.name ?? "", address: p?.address ?? "", type: p?.type ?? "apartments",
  units: p?.units != null ? String(p.units) : "", sqft: p?.sqft != null ? String(p.sqft) : "",
  ownerEntity: p?.ownerEntity ?? "", manager: p?.manager ?? "", acquiredDate: p?.acquiredDate ?? "",
  purchasePrice: p?.purchasePrice != null ? String(p.purchasePrice) : "", status: p?.status ?? "owned", notes: p?.notes ?? "",
});
const int = (s: string) => (s.trim() ? Math.round(Number(s.replace(/[^0-9.]/g, ""))) || null : null);
const money = (s: string) => (s.trim() ? Number(s.replace(/[^0-9.]/g, "")) || null : null);

export function PropertyFormDialog({ property, open, onClose, onSaved }: {
  property: Property | null; open: boolean; onClose: () => void; onSaved: (p: Property) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<F>(() => toForm(property));
  const set = (k: string) => (v: string) => setF(prev => ({ ...prev, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: f.name.trim(), address: f.address.trim(), type: f.type,
        units: int(f.units), sqft: int(f.sqft), ownerEntity: f.ownerEntity.trim() || null, manager: f.manager.trim() || null,
        acquiredDate: f.acquiredDate || null, purchasePrice: money(f.purchasePrice), status: f.status, notes: f.notes.trim() || null,
      };
      const res = property ? await apiRequest("PATCH", `/api/properties/${property.id}`, body) : await apiRequest("POST", "/api/properties", body);
      return (await res.json()) as Property;
    },
    onSuccess: p => { qc.invalidateQueries({ queryKey: ["/api/properties"] }); toast({ title: property ? "Property saved" : "Property added" }); onSaved(p); },
    onError: (e: Error) => toast({ title: "Could not save property", description: errorText(e), variant: "destructive" }),
  });

  const T = (k: string, label: string, o: { placeholder?: string; type?: string; span?: boolean } = {}) => (
    <div className={`space-y-1.5 ${o.span ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={`pf-${k}`}>{label}</Label>
      <Input id={`pf-${k}`} type={o.type} value={f[k]} onChange={e => set(k)(e.target.value)} placeholder={o.placeholder} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{property ? "Edit property" : "Add property"}</DialogTitle>
          <DialogDescription>An owned property. Monthly figures come from the manager's reports on its Financials tab.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (f.name.trim()) save.mutate(); }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {T("name", "Name", { placeholder: "e.g. Trexler Park" })}
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={f.type} onValueChange={set("type")}>
                <SelectTrigger aria-label="Property type"><SelectValue /></SelectTrigger>
                <SelectContent>{PROPERTY_TYPES.map(t => <SelectItem key={t} value={t}>{PROPERTY_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {T("address", "Address", { span: true, placeholder: "Street, town, state" })}
            {T("units", "Units", { placeholder: "Apartments" })}
            {T("sqft", "Square feet", { placeholder: "Retail / commercial" })}
            {T("ownerEntity", "Owner entity", { placeholder: "e.g. DP Trexler LLC" })}
            {T("manager", "Management company", { placeholder: "e.g. JLL" })}
            {T("acquiredDate", "Acquired", { type: "date" })}
            {T("purchasePrice", "Purchase price ($)")}
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={f.status} onValueChange={set("status")}>
                <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="owned">Owned</SelectItem><SelectItem value="sold">Sold</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-notes">Notes</Label>
            <Textarea id="pf-notes" rows={2} value={f.notes} onChange={e => set("notes")(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!f.name.trim() || save.isPending}>
              {save.isPending && <Loader2 size={13} className="animate-spin mr-1" />} {property ? "Save" : "Add property"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

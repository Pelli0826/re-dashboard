// A project's document links (permits, contracts, financials…), shown inside its card on the
// Projects page. Links with no project are the firm's company-wide documents.
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Document, Project } from "@shared/schema";
import { insertDocumentSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = ["permits", "contracts", "financials", "legal", "closing", "other"] as const;

const catColor: Record<string, string> = {
  permits: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  contracts: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  financials: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  legal: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  other: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const formSchema = insertDocumentSchema.extend({
  projectId: z.number().nullable().optional(),
  uploadedAt: z.string().min(1),
});
type FormValues = z.infer<typeof formSchema>;

const SHOWN = 4;

export function ProjectDocuments({ projectId, projects }: { projectId: number | null; projects: Project[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { data: allDocs = [] } = useQuery<Document[]>({ queryKey: ["/api/documents"] });
  const docs = allDocs.filter(d => (d.projectId ?? null) === projectId)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const shown = showAll ? docs : docs.slice(0, SHOWN);

  const today = new Date().toISOString().split("T")[0];
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", category: "contracts", url: "", notes: "", uploadedAt: today, projectId },
  });

  function openNew() { form.reset({ name: "", category: "contracts", url: "", notes: "", uploadedAt: today, projectId }); setEditing(null); setOpen(true); }
  function openEdit(d: Document) {
    form.reset({ name: d.name, category: d.category, url: d.url ?? "", notes: d.notes ?? "", uploadedAt: d.uploadedAt, projectId: d.projectId ?? null });
    setEditing(d); setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing ? apiRequest("PATCH", `/api/documents/${editing.id}`, data) : apiRequest("POST", "/api/documents", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/documents"] }); setOpen(false); toast({ title: editing ? "Document updated" : "Document added" }); },
  });

  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/documents/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Document removed" }); },
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Documents{docs.length ? ` (${docs.length})` : ""}</span>
        <button onClick={openNew} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid={`button-add-doc-${projectId ?? "general"}`}>
          <Plus size={11} /> Add link
        </button>
      </div>
      {docs.length === 0 && <p className="text-xs text-muted-foreground">No document links yet.</p>}
      {shown.map(d => (
        <div key={d.id} data-testid={`row-doc-${d.id}`} className="group flex items-center gap-1.5 text-xs">
          <FileText size={11} className="text-muted-foreground shrink-0" />
          {d.url
            ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="truncate text-foreground hover:text-primary hover:underline" title={d.notes ?? d.name}>{d.name}</a>
            : <span className="truncate text-foreground" title={d.notes ?? d.name}>{d.name}</span>}
          {d.url && <ExternalLink size={10} className="text-muted-foreground shrink-0" />}
          <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full font-medium capitalize text-[10px] ${catColor[d.category] ?? ""}`}>{d.category}</span>
          <button onClick={() => openEdit(d)} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Edit ${d.name}`}><Pencil size={10} /></button>
          <button onClick={async () => { if (await confirm({ title: `Delete ${d.name}?` })) remove.mutate(d.id); }} className="p-1 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Delete ${d.name}`}><Trash2 size={10} /></button>
        </div>
      ))}
      {docs.length > SHOWN && (
        <button onClick={() => setShowAll(v => !v)} className="text-xs text-primary hover:underline">
          {showAll ? "Show fewer" : `Show all ${docs.length}`}
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? "Edit document" : "Add document"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Document name</FormLabel>
                  <FormControl><Input data-testid="input-doc-name" placeholder="e.g. Construction loan agreement" {...field} /></FormControl><FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="projectId" render={({ field }) => (
                  <FormItem><FormLabel>Project</FormLabel>
                    <Select value={field.value ? String(field.value) : "none"} onValueChange={v => field.onChange(v === "none" ? null : Number(v))}>
                      <FormControl><SelectTrigger data-testid="select-doc-project-form"><SelectValue placeholder="Company-wide" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="none">Company-wide</SelectItem>
                        {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem><FormLabel>Category</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-doc-category"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                      </SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="url" render={({ field }) => (
                <FormItem><FormLabel>Link (optional)</FormLabel>
                  <FormControl><Input data-testid="input-doc-url" placeholder="https://app.box.com/…" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel>
                  <FormControl><Input data-testid="input-doc-notes" placeholder="Optional description" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="uploadedAt" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel>
                  <FormControl><Input data-testid="input-doc-date" type="date" {...field} /></FormControl><FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-doc" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
                  {editing ? "Update" : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

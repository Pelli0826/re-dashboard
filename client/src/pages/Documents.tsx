import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Document, InsertDocument, Project } from "@shared/schema";
import { insertDocumentSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, ExternalLink, FileText, FolderOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const catIcon: Record<string, React.ReactNode> = {
  permits: <FileText size={14} />, contracts: <FileText size={14} />, financials: <FileText size={14} />,
  legal: <FileText size={14} />, closing: <FileText size={14} />, other: <FileText size={14} />,
};

const formSchema = insertDocumentSchema.extend({
  projectId: z.coerce.number().optional(),
  uploadedAt: z.string().min(1),
});
type FormValues = z.infer<typeof formSchema>;

export default function Documents() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [filterCat, setFilterCat] = useState<string>("all");

  const { data: docs = [], isLoading } = useQuery<Document[]>({ queryKey: ["/api/documents"] });
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const today = new Date().toISOString().split("T")[0];
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", category: "contracts", url: "", notes: "", uploadedAt: today },
  });

  function openNew() { form.reset({ name: "", category: "contracts", url: "", notes: "", uploadedAt: today }); setEditing(null); setOpen(true); }
  function openEdit(d: Document) {
    form.reset({ name: d.name, category: d.category, url: d.url ?? "", notes: d.notes ?? "", uploadedAt: d.uploadedAt, projectId: d.projectId ?? undefined });
    setEditing(d); setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing ? apiRequest("PATCH", `/api/documents/${editing.id}`, data) : apiRequest("POST", "/api/documents", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/documents"] }); setOpen(false); toast({ title: editing ? "Document updated" : "Document added" }); },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/documents/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Document removed" }); },
  });

  const filtered = docs.filter(d => {
    const matchProject = selectedProject === "all" || (selectedProject === "general" ? !d.projectId : d.projectId === Number(selectedProject));
    const matchCat = filterCat === "all" || d.category === filterCat;
    return matchProject && matchCat;
  });

  // Group by project
  const grouped: Record<string, Document[]> = { general: [] };
  filtered.forEach(d => {
    const key = d.projectId ? String(d.projectId) : "general";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(d);
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Documents</h1>
          <p className="text-sm text-muted-foreground">{docs.length} document{docs.length !== 1 ? "s" : ""} tracked</p>
        </div>
        <Button data-testid="button-add-doc" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Document
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={selectedProject} onValueChange={setSelectedProject}>
          <SelectTrigger className="w-44 h-8 text-sm" data-testid="select-doc-project">
            <SelectValue placeholder="All Projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            <SelectItem value="general">General</SelectItem>
            {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex gap-1 flex-wrap">
          {["all", ...CATEGORIES].map(c => (
            <button
              key={c}
              onClick={() => setFilterCat(c)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${filterCat === c ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
              data-testid={`filter-cat-${c}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped document tables */}
      {Object.entries(grouped).filter(([, items]) => items.length > 0).map(([key, items]) => {
        const projectName = key === "general" ? "General / Company-Wide" : (projects.find(p => p.id === Number(key))?.name ?? `Project #${key}`);
        return (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <FolderOpen size={14} className="text-primary" /> {projectName}
                <span className="text-muted-foreground font-normal">({items.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Document</th>
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Category</th>
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium hidden lg:table-cell">Notes</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">Added</th>
                    <th className="text-center px-4 py-2 text-xs text-muted-foreground font-medium">Link</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map(d => (
                    <tr key={d.id} data-testid={`row-doc-${d.id}`} className="hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-foreground">{d.name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${catColor[d.category] ?? ""}`}>{d.category}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell max-w-xs truncate">{d.notes ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground hidden md:table-cell">{d.uploadedAt}</td>
                      <td className="px-4 py-2.5 text-center">
                        {d.url ? (
                          <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center p-1.5 rounded hover:bg-primary/10 text-primary transition-colors" data-testid={`link-doc-${d.id}`}>
                            <ExternalLink size={13} />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => openEdit(d)} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-edit-doc-${d.id}`}><Pencil size={12} /></button>
                          <button onClick={() => remove.mutate(d.id)} className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors" data-testid={`button-delete-doc-${d.id}`}><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}
      {filtered.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">No documents yet. Add links to permits, contracts, financials, and more.</div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? "Edit Document" : "Add Document"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Document Name</FormLabel>
                  <FormControl><Input data-testid="input-doc-name" placeholder="e.g. Construction Loan Agreement" {...field} /></FormControl><FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="projectId" render={({ field }) => (
                  <FormItem><FormLabel>Project</FormLabel>
                    <Select value={field.value ? String(field.value) : "none"} onValueChange={v => field.onChange(v === "none" ? undefined : Number(v))}>
                      <FormControl><SelectTrigger data-testid="select-doc-project-form"><SelectValue placeholder="General" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="none">General</SelectItem>
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
                <FormItem><FormLabel>Link URL (optional)</FormLabel>
                  <FormControl><Input data-testid="input-doc-url" placeholder="https://drive.google.com/…" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
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

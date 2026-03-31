import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Contact, InsertContact, Project } from "@shared/schema";
import { insertContactSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, Mail, Phone, User } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const ROLES = ["lender", "broker", "attorney", "investor", "contractor", "architect", "other"] as const;

const roleColor: Record<string, string> = {
  lender: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  broker: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  attorney: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  investor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  contractor: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  architect: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  other: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const roleInitialColor: Record<string, string> = {
  lender: "bg-blue-600",
  broker: "bg-purple-600",
  attorney: "bg-yellow-600",
  investor: "bg-green-600",
  contractor: "bg-orange-600",
  architect: "bg-pink-600",
  other: "bg-gray-500",
};

const formSchema = insertContactSchema;
type FormValues = z.infer<typeof formSchema>;

export default function Contacts() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [filterRole, setFilterRole] = useState("all");
  const [search, setSearch] = useState("");

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({ queryKey: ["/api/contacts"] });
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", role: "broker", company: "", email: "", phone: "", projectIds: "", notes: "" },
  });

  function openNew() { form.reset({ name: "", role: "broker", company: "", email: "", phone: "", projectIds: "", notes: "" }); setEditing(null); setOpen(true); }
  function openEdit(c: Contact) {
    form.reset({ name: c.name, role: c.role, company: c.company ?? "", email: c.email ?? "", phone: c.phone ?? "", projectIds: c.projectIds ?? "", notes: c.notes ?? "" });
    setEditing(c); setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing ? apiRequest("PATCH", `/api/contacts/${editing.id}`, data) : apiRequest("POST", "/api/contacts", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/contacts"] }); setOpen(false); toast({ title: editing ? "Contact updated" : "Contact added" }); },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/contacts/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/contacts"] }); toast({ title: "Contact removed" }); },
  });

  const filtered = contacts.filter(c => {
    const matchRole = filterRole === "all" || c.role === filterRole;
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.company ?? "").toLowerCase().includes(search.toLowerCase());
    return matchRole && matchSearch;
  });

  function getProjectNames(projectIds: string | null): string {
    if (!projectIds) return "";
    try {
      const ids: number[] = JSON.parse(projectIds);
      return ids.map(id => projects.find(p => p.id === id)?.name ?? `#${id}`).join(", ");
    } catch { return ""; }
  }

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Contacts</h1>
          <p className="text-sm text-muted-foreground">{contacts.length} contacts across {ROLES.length} roles</p>
        </div>
        <Button data-testid="button-add-contact" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Contact
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search name or company…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-52 h-8 text-sm"
          data-testid="input-contact-search"
        />
        <div className="flex gap-1 flex-wrap">
          {["all", ...ROLES].map(r => (
            <button
              key={r}
              onClick={() => setFilterRole(r)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${filterRole === r ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
              data-testid={`filter-role-${r}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Contact cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map(c => {
          const initials = c.name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();
          const projectNames = getProjectNames(c.projectIds);
          return (
            <Card key={c.id} data-testid={`card-contact-${c.id}`} className="flex flex-col">
              <CardContent className="pt-4 pb-4 flex gap-3">
                {/* Avatar */}
                <div className={`w-10 h-10 rounded-full ${roleInitialColor[c.role] ?? "bg-gray-500"} flex items-center justify-center text-white text-sm font-bold shrink-0`}>
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <div>
                      <div className="font-semibold text-sm text-foreground leading-snug">{c.name}</div>
                      {c.company && <div className="text-xs text-muted-foreground">{c.company}</div>}
                    </div>
                    <div className="flex gap-0.5 shrink-0">
                      <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground" data-testid={`button-edit-contact-${c.id}`}><Pencil size={11} /></button>
                      <button onClick={() => remove.mutate(c.id)} className="p-1.5 hover:bg-destructive/10 rounded transition-colors text-muted-foreground hover:text-destructive" data-testid={`button-delete-contact-${c.id}`}><Trash2 size={11} /></button>
                    </div>
                  </div>
                  <div className="mt-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${roleColor[c.role] ?? "bg-muted text-muted-foreground"}`}>{c.role}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                        <Mail size={11} /> {c.email}
                      </a>
                    )}
                    {c.phone && (
                      <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                        <Phone size={11} /> {c.phone}
                      </a>
                    )}
                  </div>
                  {projectNames && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span className="font-medium">Projects:</span> {projectNames}
                    </div>
                  )}
                  {c.notes && <p className="mt-1.5 text-xs text-muted-foreground italic">{c.notes}</p>}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">No contacts found.</div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing ? "Edit Contact" : "New Contact"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Full Name</FormLabel>
                  <FormControl><Input data-testid="input-contact-name" placeholder="Jane Smith" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="company" render={({ field }) => (
                  <FormItem><FormLabel>Company</FormLabel>
                    <FormControl><Input data-testid="input-contact-company" placeholder="Acme Corp" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="role" render={({ field }) => (
                  <FormItem><FormLabel>Role</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-contact-role"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {ROLES.map(r => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel>
                    <FormControl><Input data-testid="input-contact-email" type="email" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel>
                    <FormControl><Input data-testid="input-contact-phone" type="tel" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel>
                  <FormControl><Input data-testid="input-contact-notes" placeholder="Optional" {...field} value={field.value ?? ""} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-contact" disabled={save.isPending}>
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

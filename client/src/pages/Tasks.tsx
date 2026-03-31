import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Task, InsertTask, Project } from "@shared/schema";
import { insertTaskSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CheckCircle2, Circle, Clock, AlertTriangle, Plus, Trash2,
  Loader2, Bell, BellOff, CalendarDays, Tag, User, ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// ── helpers ────────────────────────────────────────────────────────────────
const today = new Date().toISOString().split("T")[0];

function isOverdue(dueDate: string | null | undefined, status: string) {
  if (!dueDate || status === "done") return false;
  return dueDate < today;
}

function isDueToday(dueDate: string | null | undefined, status: string) {
  if (!dueDate || status === "done") return false;
  return dueDate === today;
}

function isReminderActive(reminderDate: string | null | undefined, status: string) {
  if (!reminderDate || status === "done") return false;
  return reminderDate <= today;
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = Math.ceil((new Date(dateStr).getTime() - new Date(today).getTime()) / 86400000);
  return diff;
}

function dueDateLabel(task: Task) {
  if (!task.dueDate) return null;
  if (task.status === "done") return null;
  const d = daysUntil(task.dueDate);
  if (d === null) return null;
  if (d < 0) return { text: `${Math.abs(d)}d overdue`, cls: "text-red-500 font-semibold" };
  if (d === 0) return { text: "Due today", cls: "text-orange-500 font-semibold" };
  if (d <= 3) return { text: `Due in ${d}d`, cls: "text-orange-400" };
  return { text: task.dueDate, cls: "text-muted-foreground" };
}

const PRIORITY_CFG: Record<string, { label: string; cls: string; dot: string }> = {
  urgent: { label: "Urgent",  cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",    dot: "bg-red-500" },
  high:   { label: "High",    cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300", dot: "bg-orange-400" },
  medium: { label: "Medium",  cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300", dot: "bg-yellow-400" },
  low:    { label: "Low",     cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400", dot: "bg-slate-400" },
};

const STATUS_ORDER = ["open", "in-progress", "done"] as const;
const CATEGORIES = ["general", "permit", "closing", "finance", "legal", "construction"];

// ── form schema ────────────────────────────────────────────────────────────
const formSchema = insertTaskSchema.extend({
  title: z.string().min(1, "Title required"),
});
type FormValues = z.infer<typeof formSchema>;

// ── component ──────────────────────────────────────────────────────────────
export default function Tasks() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("open+in-progress");
  const [filterPriority, setFilterPriority] = useState<string>("all");

  const { data: allTasks = [], isLoading } = useQuery<Task[]>({ queryKey: ["/api/tasks"] });
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const projectMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p.name])), [projects]);

  // ── Reminders: tasks whose reminderDate <= today and not done
  const reminders = useMemo(() =>
    allTasks.filter(t => isReminderActive(t.reminderDate, t.status))
      .sort((a, b) => (a.dueDate ?? "") < (b.dueDate ?? "") ? -1 : 1),
    [allTasks]
  );

  // ── Filter tasks
  const filtered = useMemo(() => {
    let list = allTasks;
    if (filterStatus === "open+in-progress") list = list.filter(t => t.status === "open" || t.status === "in-progress");
    else if (filterStatus !== "all") list = list.filter(t => t.status === filterStatus);
    if (filterPriority !== "all") list = list.filter(t => t.priority === filterPriority);
    // Sort: overdue first, then by due date, then priority
    return list.sort((a, b) => {
      const aOver = isOverdue(a.dueDate, a.status) ? 0 : 1;
      const bOver = isOverdue(b.dueDate, b.status) ? 0 : 1;
      if (aOver !== bOver) return aOver - bOver;
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      const pOrder = ["urgent", "high", "medium", "low"];
      return pOrder.indexOf(a.priority) - pOrder.indexOf(b.priority);
    });
  }, [allTasks, filterStatus, filterPriority]);

  // ── Stats
  const stats = useMemo(() => ({
    open: allTasks.filter(t => t.status === "open").length,
    inProgress: allTasks.filter(t => t.status === "in-progress").length,
    done: allTasks.filter(t => t.status === "done").length,
    overdue: allTasks.filter(t => isOverdue(t.dueDate, t.status)).length,
  }), [allTasks]);

  // ── Form
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "", description: "", projectId: undefined, priority: "medium",
      status: "open", dueDate: "", reminderDate: "", assignedTo: "",
      category: "general", createdAt: new Date().toISOString(), notes: "",
      completedAt: null,
    },
  });

  function openNew() {
    setEditTask(null);
    form.reset({
      title: "", description: "", projectId: undefined, priority: "medium",
      status: "open", dueDate: "", reminderDate: "", assignedTo: "",
      category: "general", createdAt: new Date().toISOString(), notes: "",
      completedAt: null,
    });
    setOpen(true);
  }

  function openEdit(t: Task) {
    setEditTask(t);
    form.reset({
      title: t.title, description: t.description ?? "", projectId: t.projectId ?? undefined,
      priority: t.priority, status: t.status, dueDate: t.dueDate ?? "",
      reminderDate: t.reminderDate ?? "", assignedTo: t.assignedTo ?? "",
      category: t.category ?? "general", createdAt: t.createdAt, notes: t.notes ?? "",
      completedAt: t.completedAt,
    });
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => {
      const payload = {
        ...data,
        projectId: data.projectId ?? null,
        dueDate: data.dueDate || null,
        reminderDate: data.reminderDate || null,
        assignedTo: data.assignedTo || null,
        description: data.description || null,
        notes: data.notes || null,
        completedAt: data.status === "done" && !editTask?.completedAt ? new Date().toISOString() : (data.completedAt ?? null),
      };
      if (editTask) return apiRequest("PATCH", `/api/tasks/${editTask.id}`, payload);
      return apiRequest("POST", "/api/tasks", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      setOpen(false);
      toast({ title: editTask ? "Task updated" : "Task added" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/tasks/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/tasks"] }); toast({ title: "Task deleted" }); },
  });

  // Quick status toggle (open → in-progress → done → open)
  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => {
      const next = status === "open" ? "in-progress" : status === "in-progress" ? "done" : "open";
      const completedAt = next === "done" ? new Date().toISOString() : null;
      return apiRequest("PATCH", `/api/tasks/${id}`, { status: next, completedAt });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/tasks"] }),
  });

  if (isLoading) return (
    <div className="flex items-center gap-2 text-muted-foreground h-32">
      <Loader2 className="animate-spin" size={16} /> Loading tasks…
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Tasks & Reminders</h1>
          <p className="text-sm text-muted-foreground">Track action items across all projects</p>
        </div>
        <Button data-testid="button-add-task" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Task
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Open" value={stats.open} icon={<Circle size={15} className="text-primary" />} />
        <KpiCard label="In Progress" value={stats.inProgress} icon={<Clock size={15} className="text-blue-500" />} />
        <KpiCard label="Overdue" value={stats.overdue} icon={<AlertTriangle size={15} className="text-red-500" />} danger={stats.overdue > 0} />
        <KpiCard label="Done" value={stats.done} icon={<CheckCircle2 size={15} className="text-green-500" />} />
      </div>

      {/* Reminders banner */}
      {reminders.length > 0 && (
        <Card className="border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/30">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-orange-700 dark:text-orange-300">
              <Bell size={14} className="animate-pulse" />
              {reminders.length} Active Reminder{reminders.length > 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-2">
            {reminders.map(t => {
              const due = dueDateLabel(t);
              return (
                <div key={t.id} className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${PRIORITY_CFG[t.priority]?.dot ?? "bg-gray-400"}`} />
                    <div className="min-w-0">
                      <span
                        className="text-sm font-medium text-foreground cursor-pointer hover:text-primary truncate block"
                        onClick={() => openEdit(t)}
                      >{t.title}</span>
                      {t.projectId && <span className="text-xs text-muted-foreground">{projectMap[t.projectId]}</span>}
                    </div>
                  </div>
                  {due && <span className={`text-xs shrink-0 ${due.cls}`}>{due.text}</span>}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-44 h-8 text-xs" data-testid="select-task-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open+in-progress">Open & In Progress</SelectItem>
            <SelectItem value="all">All Tasks</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in-progress">In Progress</SelectItem>
            <SelectItem value="done">Done</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterPriority} onValueChange={setFilterPriority}>
          <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-task-priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Priorities</SelectItem>
            {["urgent","high","medium","low"].map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1">{filtered.length} task{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Task list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <CheckCircle2 size={40} className="text-muted-foreground opacity-30" />
          <p className="text-sm text-muted-foreground">No tasks matching these filters.</p>
          <Button size="sm" variant="outline" onClick={openNew}>Add a task</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(t => {
            const pCfg = PRIORITY_CFG[t.priority] ?? PRIORITY_CFG.medium;
            const due = dueDateLabel(t);
            const reminder = isReminderActive(t.reminderDate, t.status);
            const overdue = isOverdue(t.dueDate, t.status);
            return (
              <Card
                key={t.id}
                data-testid={`card-task-${t.id}`}
                className={`transition-colors ${overdue ? "border-red-300 dark:border-red-800" : ""}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    {/* Status toggle */}
                    <button
                      data-testid={`btn-toggle-status-${t.id}`}
                      onClick={() => toggleStatus.mutate({ id: t.id, status: t.status })}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                      title={`Status: ${t.status} — click to advance`}
                    >
                      {t.status === "done"
                        ? <CheckCircle2 size={18} className="text-green-500" />
                        : t.status === "in-progress"
                        ? <Clock size={18} className="text-blue-500" />
                        : <Circle size={18} />
                      }
                    </button>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span
                          className={`text-sm font-medium cursor-pointer hover:text-primary ${t.status === "done" ? "line-through text-muted-foreground" : "text-foreground"}`}
                          onClick={() => openEdit(t)}
                        >{t.title}</span>
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${pCfg.cls}`}>{pCfg.label}</Badge>
                        {reminder && (
                          <span title="Reminder active">
                            <Bell size={12} className="text-orange-400 mt-0.5" />
                          </span>
                        )}
                      </div>

                      {t.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{t.description}</p>
                      )}

                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        {t.projectId && (
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Tag size={10} /> {projectMap[t.projectId] ?? `Project ${t.projectId}`}
                          </span>
                        )}
                        {t.category && (
                          <span className="text-[11px] text-muted-foreground capitalize">{t.category}</span>
                        )}
                        {t.assignedTo && (
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <User size={10} /> {t.assignedTo}
                          </span>
                        )}
                        {due && (
                          <span className={`flex items-center gap-1 text-[11px] ${due.cls}`}>
                            <CalendarDays size={10} /> {due.text}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(t)}
                        className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground text-xs"
                        title="Edit"
                      >✎</button>
                      <button
                        data-testid={`btn-delete-task-${t.id}`}
                        onClick={() => remove.mutate(t.id)}
                        className="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                        title="Delete"
                      ><Trash2 size={13} /></button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editTask ? "Edit Task" : "Add Task"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              {/* Title */}
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl><Input placeholder="Task title…" data-testid="input-task-title" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Description */}
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl><Textarea placeholder="Optional details…" className="resize-none" rows={2} {...field} value={field.value ?? ""} /></FormControl>
                </FormItem>
              )} />

              {/* Priority + Status */}
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="priority" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-task-priority-form"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {["urgent","high","medium","low"].map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="in-progress">In Progress</SelectItem>
                        <SelectItem value="done">Done</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>

              {/* Due date + Reminder */}
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="dueDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl><Input type="date" data-testid="input-task-due" {...field} value={field.value ?? ""} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="reminderDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1"><Bell size={11} /> Reminder Date</FormLabel>
                    <FormControl><Input type="date" data-testid="input-task-reminder" {...field} value={field.value ?? ""} /></FormControl>
                  </FormItem>
                )} />
              </div>

              {/* Project + Category */}
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="projectId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project</FormLabel>
                    <Select value={field.value != null ? String(field.value) : "none"} onValueChange={v => field.onChange(v === "none" ? null : Number(v))}>
                      <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select value={field.value ?? "general"} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>

              {/* Assigned To */}
              <FormField control={form.control} name="assignedTo" render={({ field }) => (
                <FormItem>
                  <FormLabel>Assigned To</FormLabel>
                  <FormControl><Input placeholder="Name or role…" {...field} value={field.value ?? ""} /></FormControl>
                </FormItem>
              )} />

              {/* Notes */}
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea placeholder="Additional notes…" className="resize-none" rows={2} {...field} value={field.value ?? ""} /></FormControl>
                </FormItem>
              )} />

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={save.isPending} data-testid="button-save-task">
                  {save.isPending ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
                  {editTask ? "Save Changes" : "Add Task"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── KpiCard ──────────────────────────────────────────────────────────────
function KpiCard({ label, value, icon, danger }: { label: string; value: number; icon: React.ReactNode; danger?: boolean }) {
  return (
    <Card className={danger && value > 0 ? "border-red-300 dark:border-red-800" : ""}>
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
          {icon} {label}
        </div>
        <div className={`text-2xl font-bold font-mono ${danger && value > 0 ? "text-red-500" : "text-foreground"}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, DealFile } from "@shared/schema";
import { Trash2, Loader2, Paperclip, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";

// ── Files saved to the deal ────────────────────────────────────────────────
function fmtSize(n: number) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

export function DealFiles({ deal }: { deal: PipelineDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const key = ["/api/pipeline", deal.id, "files"];
  const { data: files = [] } = useQuery<DealFile[]>({ queryKey: key });

  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/pipeline/${deal.id}/files`, { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? `Upload failed (${res.status})`);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "activity"] });
      toast({ title: "File saved to the deal" });
    } catch (e: any) {
      toast({ title: "Could not upload", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/files/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Files</h3>
        <input ref={input} type="file" className="hidden" accept=".pdf,.xlsx,.xlsm,.xls,.csv,.docx,.png,.jpg,.jpeg" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        <Button size="sm" variant="ghost" className="gap-1 h-7" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />} Add file
        </Button>
      </div>
      {files.length === 0
        ? <p className="text-sm text-muted-foreground">No files yet. OMs uploaded through Upload OM are saved here automatically.</p>
        : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {files.map(f => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <a href={`/api/files/${f.id}/download${f.mime === "application/pdf" ? "?inline=1" : ""}`} target="_blank" rel="noopener" className="text-foreground hover:underline truncate">{f.name}</a>
                {f.kind === "om" && <span className="text-[11px] px-1.5 rounded bg-muted text-muted-foreground">OM</span>}
                {f.kind === "loi" && <span className="text-[11px] px-1.5 rounded bg-muted text-muted-foreground">LOI</span>}
                <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">{fmtSize(f.size)}</span>
                <a href={`/api/files/${f.id}/download`} aria-label={`Download ${f.name}`} className="p-1 text-muted-foreground hover:text-foreground"><Download size={13} /></a>
                <button aria-label={`Delete ${f.name}`} className="p-1 text-muted-foreground hover:text-destructive"
                  onClick={async () => { if (await confirm({ title: `Delete ${f.name}?` })) remove.mutate(f.id); }}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

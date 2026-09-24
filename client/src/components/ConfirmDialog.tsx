import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmOptions {
  title: string;
  description?: string;
  /** Related records that will be deleted too, e.g. ["3 tasks", "1 underwriting model"] */
  alsoDeletes?: string[];
  /** Related records that are kept, e.g. ["2 contacts (unlinked from this project)"] */
  keeps?: string[];
  confirmLabel?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => window.confirm("Are you sure?"));

/** Ask before deleting: `if (await confirm({ title: "Delete X?" })) remove.mutate(id)` */
export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>();

  const confirm = useCallback<ConfirmFn>(o => {
    setOpts(o);
    return new Promise<boolean>(resolve => { resolver.current = resolve; });
  }, []);

  const close = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = undefined;
    setOpts(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!opts} onOpenChange={open => { if (!open) close(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {opts?.description && <p>{opts.description}</p>}
                {!!opts?.alsoDeletes?.length && (
                  <div>
                    <p className="font-medium text-foreground">This also permanently deletes:</p>
                    <ul className="list-disc pl-5">{opts.alsoDeletes.map(x => <li key={x}>{x}</li>)}</ul>
                  </div>
                )}
                {!!opts?.keeps?.length && (
                  <div>
                    <p className="font-medium text-foreground">Kept:</p>
                    <ul className="list-disc pl-5">{opts.keeps.map(x => <li key={x}>{x}</li>)}</ul>
                  </div>
                )}
                <p>This can't be undone. Download a backup first (sidebar download icon) if you may need it later.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => close(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {opts?.confirmLabel ?? "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/** "1 task", "3 tasks"; returns null for zero so it can be filtered out. */
export function plural(n: number, one: string, many = `${one}s`): string | null {
  return n > 0 ? `${n} ${n === 1 ? one : many}` : null;
}

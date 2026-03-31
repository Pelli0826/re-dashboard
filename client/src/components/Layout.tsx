import { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@shared/schema";
import {
  LayoutDashboard, FolderKanban, TrendingUp, BadgeDollarSign,
  LineChart, Users, UserCheck, FileText, CheckSquare, Calculator,
  ChevronLeft, ChevronRight, Sun, Moon, Building2, LogOut
} from "lucide-react";
import PerplexityAttribution from "./PerplexityAttribution";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Overview" },
  { href: "/projects", icon: FolderKanban, label: "Projects" },
  { href: "/pipeline", icon: TrendingUp, label: "Pipeline" },
  { href: "/arm", icon: BadgeDollarSign, label: "ARM Loans" },
  { href: "/cashflow", icon: LineChart, label: "Cash Flow" },
  { href: "/investors", icon: UserCheck, label: "Investors" },
  { href: "/contacts", icon: Users, label: "Contacts" },
  { href: "/documents", icon: FileText, label: "Documents" },
  { href: "/tasks", icon: CheckSquare, label: "Tasks" },
  { href: "/underwriting", icon: Calculator, label: "Underwriting" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  // Live reminder badge — count active reminders
  const { data: allTasks = [] } = useQuery<Task[]>({ queryKey: ["/api/tasks"] });
  const today = new Date().toISOString().split("T")[0];
  const reminderCount = useMemo(() =>
    allTasks.filter(t => t.reminderDate && t.reminderDate <= today && t.status !== "done").length,
    [allTasks, today]
  );
  const overdueCount = useMemo(() =>
    allTasks.filter(t => t.dueDate && t.dueDate < today && t.status !== "done").length,
    [allTasks, today]
  );
  const badgeCount = Math.max(reminderCount, overdueCount);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  }

  const currentLabel = navItems.find(n => n.href === location)?.label ?? "Dashboard";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-all duration-300 ${collapsed ? "w-16" : "w-56"} shrink-0`}
      >
        {/* Logo */}
        <div className={`flex items-center gap-2.5 px-4 py-4 border-b border-sidebar-border ${collapsed ? "justify-center px-2" : ""}`}>
          <svg aria-label="RE Dashboard" viewBox="0 0 32 32" width="28" height="28" fill="none" className="shrink-0">
            <rect x="2" y="14" width="10" height="16" rx="1" fill="currentColor" opacity="0.85"/>
            <rect x="14" y="8" width="16" height="22" rx="1" fill="currentColor"/>
            <path d="M16 2 L30 8 L30 6 L16 0 L2 6 L2 8 Z" fill="currentColor" opacity="0.6"/>
          </svg>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-xs font-bold tracking-wide uppercase text-sidebar-foreground">RE Dashboard</div>
              <div className="text-[10px] text-sidebar-foreground opacity-50 font-medium">Developer HQ</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map(({ href, icon: Icon, label }) => {
            const active = location === href;
            const isTasksNav = href === "/tasks";
            return (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                } ${collapsed ? "justify-center px-2" : ""}`}
              >
                <div className="relative shrink-0">
                  <Icon size={17} />
                  {isTasksNav && badgeCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                      {badgeCount > 9 ? "9+" : badgeCount}
                    </span>
                  )}
                </div>
                {!collapsed && <span className="flex-1">{label}</span>}
                {!collapsed && isTasksNav && badgeCount > 0 && (
                  <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none">
                    {badgeCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className={`flex ${collapsed ? "flex-col items-center gap-2 py-3" : "items-center justify-between px-3 py-3"} border-t border-sidebar-border`}>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="p-2 rounded-md hover:bg-sidebar-accent transition-colors text-sidebar-foreground opacity-70 hover:opacity-100"
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }}
            aria-label="Sign out"
            title="Sign out"
            className="p-2 rounded-md hover:bg-sidebar-accent transition-colors text-sidebar-foreground opacity-70 hover:opacity-100"
          >
            <LogOut size={15} />
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label="Collapse sidebar"
            className="p-2 rounded-md hover:bg-sidebar-accent transition-colors text-sidebar-foreground opacity-70 hover:opacity-100"
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-card shrink-0">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">{currentLabel}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6 overscroll-contain">
          {children}
          <div className="mt-8 pt-4 border-t border-border">
            <PerplexityAttribution />
          </div>
        </main>
      </div>
    </div>
  );
}

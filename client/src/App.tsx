import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import Projects from "./pages/Projects";
import Pipeline from "./pages/Pipeline";
import ARM from "./pages/ARM";
import CashFlow from "./pages/CashFlow";
import Contacts from "./pages/Contacts";
import Investors from "./pages/Investors";
import Tasks from "./pages/Tasks";
import Login from "./pages/Login";
import NotFound from "./pages/not-found";
import { Loader2 } from "lucide-react";

function AppInner() {
  const { data, isLoading, refetch } = useQuery<{ authenticated: boolean; passwordRequired: boolean; locked?: boolean }>({
    queryKey: ["/api/auth/check"],
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="animate-spin text-primary" size={24} />
    </div>
  );

  if (data?.passwordRequired && !data?.authenticated) {
    return <Login locked={!!data.locked} onLogin={() => refetch()} />;
  }

  return (
    <ConfirmProvider>
    <Router hook={useHashLocation}>
      <Layout>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/projects" component={Projects} />
          <Route path="/pipeline" component={Pipeline} />
          <Route path="/arm" component={ARM} />
          <Route path="/cashflow" component={CashFlow} />
          <Route path="/contacts" component={Contacts} />
          <Route path="/investors" component={Investors} />
          <Route path="/documents"><Redirect to="/projects" /></Route>
          <Route path="/tasks" component={Tasks} />
          {/* Underwriting lives in each deal now (Pipeline → deal → Underwriting tab). */}
          <Route path="/underwriting"><Redirect to="/pipeline" /></Route>
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </Router>
    </ConfirmProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
      <Toaster />
    </QueryClientProvider>
  );
}

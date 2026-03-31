import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
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
import Documents from "./pages/Documents";
import Tasks from "./pages/Tasks";
import Underwriting from "./pages/Underwriting";
import Login from "./pages/Login";
import NotFound from "./pages/not-found";
import { Loader2 } from "lucide-react";

function AppInner() {
  const { data, isLoading, refetch } = useQuery<{ authenticated: boolean; passwordRequired: boolean }>({
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
    return <Login onLogin={() => refetch()} />;
  }

  return (
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
          <Route path="/documents" component={Documents} />
          <Route path="/tasks" component={Tasks} />
          <Route path="/underwriting" component={Underwriting} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </Router>
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

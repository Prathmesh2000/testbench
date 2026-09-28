'use client';

import type { JobStatus, Me, Permission, ProjectSummary } from '@tb/contracts';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get } from '@/lib/api';
import { Icon } from './Icon';

// App-wide client state: server-data cache, display preferences, the current project, background jobs
// shown in the status bar, and toasts.

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the preference just lasts for this page view.
  }
};

// ---------- preferences ----------
interface Prefs {
  theme: 'dark' | 'light';
  density: 'compact' | 'comfy';
  toggleTheme(): void;
  toggleDensity(): void;
}
const PrefsContext = createContext<Prefs | null>(null);
export const usePrefs = () => useContext(PrefsContext)!;

function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Prefs['theme']>('dark');
  const [density, setDensity] = useState<Prefs['density']>('compact');
  useEffect(() => {
    // Applied after hydration; the inline script in the root layout already set the classes to avoid a flash.
    if (readPref('tb.theme') === 'light') setTheme('light');
    if (readPref('tb.density') === 'comfy') setDensity('comfy');
  }, []);
  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('comfy', density === 'comfy');
  }, [theme, density]);
  const value = useMemo<Prefs>(() => ({
    theme, density,
    toggleTheme: () => setTheme((t) => { const next = t === 'dark' ? 'light' : 'dark'; writePref('tb.theme', next); return next; }),
    toggleDensity: () => setDensity((d) => { const next = d === 'compact' ? 'comfy' : 'compact'; writePref('tb.density', next); return next; }),
  }), [theme, density]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

// ---------- current user and project ----------
interface Session {
  me: Me;
  project: ProjectSummary;
  can(permission: Permission): boolean;
  /** Organisation-wide permission (admin console, creating projects), independent of the current project. */
  canOrg(permission: Permission): boolean;
  selectProject(id: string): void;
}
const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

function SessionProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/me'), staleTime: 5 * 60_000 });
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => setProjectId(readPref('tb.project')), []);

  if (me.error) {
    const message = me.error instanceof ApiError ? me.error.message : 'Could not reach the Testbench API.';
    return <div className="empty" style={{ height: '100%' }}><Icon name="alert" size={22} /><div>{message}</div><button className="btn" onClick={() => me.refetch()}>Try again</button></div>;
  }
  if (!me.data) return <div className="empty t3" style={{ height: '100%' }}>Loading your workspace…</div>;
  // An archived project stays selectable (to read its history) but is never the default.
  const project =
    me.data.projects.find((p) => p.id === projectId) ?? me.data.projects.find((p) => !p.archived) ?? me.data.projects[0];
  if (!project) {
    return <div className="empty" style={{ height: '100%' }}><div>You are not on any project yet.</div><div className="t3">Ask a project admin to add you.</div></div>;
  }
  const value: Session = {
    me: me.data,
    project,
    can: (p) => project.permissions.includes(p),
    canOrg: (p) => me.data.orgPermissions.includes(p),
    selectProject: (id) => { writePref('tb.project', id); setProjectId(id); },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// ---------- background jobs (status bar) ----------
interface Jobs {
  jobs: (JobStatus & { label: string })[];
  track(projectId: string, jobId: string, label: string): void;
}
const JobsContext = createContext<Jobs | null>(null);
export const useJobs = () => useContext(JobsContext)!;

function JobsProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<{ projectId: string; id: string; label: string }[]>([]);
  const [status, setStatus] = useState<Record<string, JobStatus>>({});
  const queryClient = useQueryClient();
  const { notify } = useToast();

  useEffect(() => {
    const active = tracked.filter((t) => !['done', 'failed'].includes(status[t.id]?.status ?? ''));
    if (!active.length) return;
    const timer = setInterval(async () => {
      for (const t of active) {
        const job = await get<JobStatus>(`/projects/${t.projectId}/jobs/${t.id}`).catch(() => null);
        if (!job) continue;
        setStatus((s) => ({ ...s, [t.id]: job }));
        if (job.status === 'done') {
          notify(`${t.label}: ${job.processed.toLocaleString('en-IN')} cases updated`);
          queryClient.invalidateQueries({ queryKey: ['cases'] });
        } else if (job.status === 'failed') {
          notify(job.error ?? `${t.label} failed`, 'bad');
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [tracked, status, queryClient, notify]);

  const value = useMemo<Jobs>(() => ({
    jobs: tracked.map((t) => ({ ...(status[t.id] ?? { id: t.id, status: 'queued', total: 0, processed: 0, error: null }), label: t.label })),
    track: (projectId, id, label) => setTracked((ts) => [...ts, { projectId, id, label }]),
  }), [tracked, status]);
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

// ---------- toasts ----------
interface Toast {
  notify(message: string, tone?: 'ok' | 'bad'): void;
}
const ToastContext = createContext<Toast>({ notify: () => {} });
export const useToast = () => useContext(ToastContext);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'bad'; id: number } | null>(null);
  const notify = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => setToast({ message, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={useMemo(() => ({ notify }), [notify])}>
      {children}
      {toast && (
        <div key={toast.id} className={`toast ${toast.tone === 'bad' ? 'bad' : ''}`} role="status">
          <Icon name={toast.tone === 'bad' ? 'alert' : 'check'} />
          <span className="f1">{toast.message}</span>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <PrefsProvider>
        <ToastProvider>
          <SessionProvider>
            <JobsProvider>{children}</JobsProvider>
          </SessionProvider>
        </ToastProvider>
      </PrefsProvider>
    </QueryClientProvider>
  );
}

import * as React from 'react';
import { Clapperboard, FlaskConical, Library, ListChecks, ScrollText, Wand2 } from 'lucide-react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { TooltipProvider } from '@pepper/ui/components/ui';
import { AppShell, type NavItem, type Theme } from '@pepper/ui/components/layout';
import { AuthGate } from '@pepper/ui/components/SignIn';
import { JobsPage } from '@pepper/ui/pages/Jobs';
import { LogsPage } from '@pepper/ui/pages/Logs';
import { useResource, type SystemStatus } from '@pepper/ui/lib/api';
import { PreferencesDialog } from '@/components/Preferences';
import { GeneratePage } from '@/pages/Generate';
import { MediaPage } from '@/pages/Media';
import { ProjectPage } from '@/pages/Project';
import { ProjectsPage } from '@/pages/Projects';
import { RecipesPage } from '@/pages/Recipes';

const THEME_KEY = 'pepper-theme';

const NAV: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: Clapperboard, group: 'Create' },
  { to: '/generate', label: 'Generate', icon: Wand2, group: 'Create' },
  { to: '/recipes', label: 'Recipes', icon: FlaskConical, group: 'Library' },
  { to: '/media', label: 'Media', icon: Library, group: 'Library' },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, group: 'Library' },
  { to: '/logs', label: 'Logs', icon: ScrollText, group: 'Library' },
];

const BRAND = { name: 'Pepper Pro', initial: 'P', home: 'projects' };

export function App() {
  return (
    <AuthGate>
      <TooltipProvider>
        <BrowserRouter>
          <PepperPro />
        </BrowserRouter>
      </TooltipProvider>
    </AuthGate>
  );
}

function PepperPro() {
  const navigate = useNavigate();
  const [theme, setTheme] = React.useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'light');
  const [preferencesOpen, setPreferencesOpen] = React.useState(false);
  const status = useResource<SystemStatus>('/v1/system/status', 5000);

  React.useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => document.documentElement.classList.toggle('dark', event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <>
      <AppShell
        brand={BRAND}
        nav={NAV}
        catalogueLabel="Recipes"
        status={status.data}
        theme={theme}
        onThemeChange={setTheme}
        onOpenPreferences={() => setPreferencesOpen(true)}
        onOpenCatalogue={() => navigate('/recipes')}
        onStatusChanged={status.reload}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/generate" element={<GeneratePage />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/media" element={<MediaPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </AppShell>
      <PreferencesDialog
        open={preferencesOpen}
        onOpenChange={setPreferencesOpen}
        status={status.data}
        theme={theme}
        onThemeChange={setTheme}
        onChanged={status.reload}
      />
    </>
  );
}

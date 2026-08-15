import * as React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui';
import { AppShell, type Theme } from '@/components/layout';
import { CatalogueDialog } from '@/components/Catalogue';
import { PreferencesDialog } from '@/components/Preferences';
import { GeneratePage } from '@/pages/Generate';
import { AudioPage } from '@/pages/Audio';
import { TextPage } from '@/pages/Text';
import { MediaPage } from '@/pages/Media';
import { JobsPage } from '@/pages/Jobs';
import { LogsPage } from '@/pages/Logs';
import { useResource, type SystemStatus } from '@/lib/api';

const THEME_KEY = 'pepper-theme';

export function App() {
  const [theme, setTheme] = React.useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'light',
  );
  const [preferencesOpen, setPreferencesOpen] = React.useState(false);
  const [catalogueOpen, setCatalogueOpen] = React.useState(false);

  // Backend status drives the header pills and the Preferences panel. Polled
  // rather than streamed: it changes on installs and restarts, which are
  // minutes apart, and a five-second refresh is well inside what feels live.
  const status = useResource<SystemStatus>('/v1/system/status', 5000);

  React.useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);

    if (theme !== 'system') return;
    // Following the system means reacting when it changes, not only at load.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) =>
      document.documentElement.classList.toggle('dark', event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <TooltipProvider>
      <BrowserRouter>
        <AppShell
          status={status.data}
          theme={theme}
          onThemeChange={setTheme}
          onOpenPreferences={() => setPreferencesOpen(true)}
          onOpenCatalogue={() => setCatalogueOpen(true)}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/image" replace />} />
            <Route path="/image" element={<GeneratePage kind="image" />} />
            <Route path="/video" element={<GeneratePage kind="video" />} />
            <Route path="/audio" element={<AudioPage />} />
            <Route path="/text" element={<TextPage />} />
            <Route path="/media" element={<MediaPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="*" element={<Navigate to="/image" replace />} />
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
        <CatalogueDialog open={catalogueOpen} onOpenChange={setCatalogueOpen} />
      </BrowserRouter>
    </TooltipProvider>
  );
}

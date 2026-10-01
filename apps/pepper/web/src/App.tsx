import * as React from 'react';
import {
  AudioLines,
  Image as ImageIcon,
  Library,
  ListChecks,
  MessageSquareText,
  ScrollText,
  Users,
  Video,
} from 'lucide-react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@pepper/ui/components/ui';
import { AppShell, type NavItem, type Theme } from '@pepper/ui/components/layout';
import { CatalogueDialog } from '@/components/Catalogue';
import { PreferencesDialog } from '@/components/Preferences';
import { AuthGate } from '@pepper/ui/components/SignIn';
import { GeneratePage } from '@/pages/Generate';
import { ImagePage } from '@/pages/Image';
import { AudioPage } from '@/pages/Audio';
import { TextPage } from '@/pages/Text';
import { MediaPage } from '@/pages/Media';
import { JobsPage } from '@pepper/ui/pages/Jobs';
import { LogsPage } from '@pepper/ui/pages/Logs';
import { CharactersPage } from '@/pages/Characters';
import { useResource, type SystemStatus } from '@pepper/ui/lib/api';

const THEME_KEY = 'pepper-theme';

const NAV: NavItem[] = [
  { to: '/image', label: 'Image', icon: ImageIcon, group: 'Generate' },
  { to: '/video', label: 'Video', icon: Video, group: 'Generate' },
  { to: '/audio', label: 'Audio', icon: AudioLines, group: 'Generate' },
  { to: '/text', label: 'Text', icon: MessageSquareText, group: 'Generate' },
  { to: '/characters', label: 'Characters', icon: Users, group: 'Create' },
  { to: '/media', label: 'Media', icon: Library, group: 'Library' },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, group: 'Library' },
  { to: '/logs', label: 'Logs', icon: ScrollText, group: 'Library' },
];

const BRAND = { name: 'Pepper', initial: 'P', home: 'image' };

export function App() {
  return (
    <AuthGate>
      <Pepper />
    </AuthGate>
  );
}

function Pepper() {
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
          brand={BRAND}
          nav={NAV}
          status={status.data}
          theme={theme}
          onThemeChange={setTheme}
          onOpenPreferences={() => setPreferencesOpen(true)}
          onOpenCatalogue={() => setCatalogueOpen(true)}
          onStatusChanged={status.reload}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/image" replace />} />
            <Route path="/image" element={<ImagePage />} />
            <Route path="/video" element={<GeneratePage />} />
            <Route path="/audio" element={<AudioPage />} />
            <Route path="/text" element={<TextPage />} />
            <Route path="/characters" element={<CharactersPage />} />
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

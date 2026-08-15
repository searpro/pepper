import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  AudioLines,
  ChevronLeft,
  Image as ImageIcon,
  Library,
  ListChecks,
  MessageSquareText,
  Moon,
  Package,
  ScrollText,
  Settings,
  Sun,
  Video,
} from 'lucide-react';
import { Badge, Button, Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { SystemStatus } from '@/lib/api';

/**
 * The app shell: a collapsible side nav for the generation screens
 * (requirement 10) and a top bar carrying the Preferences and Catalogue
 * entries on the right, plus a live status pill.
 */

export type Theme = 'light' | 'dark' | 'system';

const NAV_ITEMS = [
  { to: '/image', label: 'Image', icon: ImageIcon, group: 'Generate' },
  { to: '/video', label: 'Video', icon: Video, group: 'Generate' },
  { to: '/audio', label: 'Audio', icon: AudioLines, group: 'Generate' },
  { to: '/text', label: 'Text', icon: MessageSquareText, group: 'Generate' },
  { to: '/media', label: 'Media', icon: Library, group: 'Library' },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, group: 'Library' },
  { to: '/logs', label: 'Logs', icon: ScrollText, group: 'Library' },
] as const;

const COLLAPSE_KEY = 'pepper-nav-collapsed';

export function AppShell({
  status,
  children,
  theme,
  onThemeChange,
  onOpenPreferences,
  onOpenCatalogue,
}: {
  status: SystemStatus | undefined;
  children: React.ReactNode;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenPreferences: () => void;
  onOpenCatalogue: () => void;
}) {
  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem(COLLAPSE_KEY) === 'true',
  );
  const location = useLocation();

  React.useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, (typeof NAV_ITEMS)[number][]>();
    for (const item of NAV_ITEMS) {
      const existing = byGroup.get(item.group) ?? [];
      existing.push(item);
      byGroup.set(item.group, existing);
    }
    return [...byGroup.entries()];
  }, []);

  const activeJobs = (status?.jobs.running ?? 0) + (status?.jobs.queued ?? 0);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200',
          collapsed ? 'w-[60px]' : 'w-[212px]',
        )}
      >
        <div className="flex h-14 items-center gap-2 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-sm font-bold">P</span>
          </div>
          {!collapsed ? (
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold leading-tight">Pepper</span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground">
                {status ? `v${status.version} · ${status.accel}` : 'connecting…'}
              </span>
            </div>
          ) : null}
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-2 scrollbar-thin">
          {groups.map(([group, items]) => (
            <div key={group} className="flex flex-col gap-1">
              {!collapsed ? (
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group}
                </p>
              ) : null}
              {items.map((item) => {
                const link = (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-primary/12 text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    {!collapsed && item.to === '/jobs' && activeJobs > 0 ? (
                      <Badge variant="primary" className="ml-auto">
                        {activeJobs}
                      </Badge>
                    ) : null}
                  </NavLink>
                );
                // A collapsed rail is unusable without labels on hover.
                return collapsed ? (
                  <Tooltip key={item.to} label={item.label}>
                    <div>{link}</div>
                  </Tooltip>
                ) : (
                  link
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size={collapsed ? 'icon' : 'sm'}
            className={cn('w-full text-muted-foreground', collapsed && 'w-full')}
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <ChevronLeft className={cn('transition-transform', collapsed && 'rotate-180')} />
            {!collapsed ? <span>Collapse</span> : null}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-sm font-semibold capitalize">
              {location.pathname.replace('/', '') || 'image'}
            </h1>
            <BackendPills status={status} />
          </div>

          <div className="flex items-center gap-1">
            <Tooltip label="Model catalogue and downloads">
              <Button variant="ghost" size="sm" onClick={onOpenCatalogue}>
                <Package />
                <span className="hidden sm:inline">Models</span>
              </Button>
            </Tooltip>
            <Tooltip label="Preferences">
              <Button variant="ghost" size="sm" onClick={onOpenPreferences}>
                <Settings />
                <span className="hidden sm:inline">Preferences</span>
              </Button>
            </Tooltip>
            <Tooltip label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </Tooltip>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
    </div>
  );
}

/** Backend health at a glance — the question every "why isn't this working" starts with. */
function BackendPills({ status }: { status: SystemStatus | undefined }) {
  if (!status) return null;

  const variantFor = (state: string) =>
    state === 'ready'
      ? ('success' as const)
      : state === 'failed' || state === 'unhealthy'
        ? ('destructive' as const)
        : state === 'starting' || state === 'installing'
          ? ('warning' as const)
          : ('outline' as const);

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      {status.backends
        .filter((backend) => backend.kind === 'server' || backend.installed)
        .map((backend) => (
          <Tooltip
            key={backend.backend}
            label={
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{backend.label}</span>
                <span>Status: {backend.status}</span>
                {backend.releaseTag ? <span>Release: {backend.releaseTag}</span> : null}
                {backend.restarts > 0 ? <span>Restarts: {backend.restarts}</span> : null}
                {backend.lastRestartReason ? <span>Last: {backend.lastRestartReason}</span> : null}
                {backend.lastError ? <span className="text-destructive">{backend.lastError}</span> : null}
              </div>
            }
          >
            <Badge variant={variantFor(backend.status)} className="cursor-default">
              <Activity className="size-2.5" />
              {backend.backend}
            </Badge>
          </Tooltip>
        ))}
    </div>
  );
}

/** Standard page frame: a title row plus content, used by every screen. */
export function Page({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:p-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

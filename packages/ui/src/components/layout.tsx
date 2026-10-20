import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronLeft, Menu, Moon, Package, Settings, Sun, X, type LucideIcon } from 'lucide-react';
import { Badge, Button, Tooltip } from './ui';
import { BackendPills, ResourceMeters } from './system-status';
import { cn } from '../lib/utils';
import type { SystemStatus } from '../lib/api';

/**
 * The app shell: a collapsible side nav for the product's screens
 * (requirement 10) and a top bar carrying the Preferences and Catalogue
 * entries on the right, plus a live status pill. The nav items and the
 * product's name are the product's; the frame is shared.
 *
 * On a phone the nav is a drawer behind a menu button: a fixed rail would
 * leave the screen itself a strip a few words wide.
 */

export type Theme = 'light' | 'dark' | 'system';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Items are grouped under this heading, in first-seen order. */
  group: string;
}

export interface ProductBrand {
  /** Shown in the nav header, e.g. "Pepper". */
  name: string;
  /** The letter in the logo tile. */
  initial: string;
  /** The heading shown on `/`, before any route is picked. */
  home: string;
}

const COLLAPSE_KEY = 'pepper-nav-collapsed';

export function AppShell({
  brand,
  nav,
  catalogueLabel = 'Models',
  status,
  children,
  theme,
  onThemeChange,
  onOpenPreferences,
  onOpenCatalogue,
  onStatusChanged,
}: {
  brand: ProductBrand;
  nav: NavItem[];
  /** The label on the catalogue button ("Models", "Recipes"). */
  catalogueLabel?: string;
  status: SystemStatus | undefined;
  /** Re-poll status now, after a lifecycle action from a backend pill. */
  onStatusChanged: () => void;
  children: React.ReactNode;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenPreferences: () => void;
  onOpenCatalogue: () => void;
}) {
  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem(COLLAPSE_KEY) === 'true',
  );
  const [drawer, setDrawer] = React.useState(false);
  const location = useLocation();

  React.useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  // Picking a screen from the drawer is the end of using it.
  React.useEffect(() => setDrawer(false), [location.pathname]);

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, NavItem[]>();
    for (const item of nav) {
      const existing = byGroup.get(item.group) ?? [];
      existing.push(item);
      byGroup.set(item.group, existing);
    }
    return [...byGroup.entries()];
  }, [nav]);

  const activeJobs = (status?.jobs.running ?? 0) + (status?.jobs.queued ?? 0);

  const navigation = (folded: boolean, drawer: boolean) => (
    <>
        <div className="flex h-14 items-center gap-2 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-sm font-bold">{brand.initial}</span>
          </div>
          {!folded ? (
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold leading-tight">{brand.name}</span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground">
                {status ? `v${status.version} · ${status.accel}` : 'connecting…'}
              </span>
            </div>
          ) : null}
          {drawer ? (
            <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setDrawer(false)} aria-label="Close navigation">
              <X />
            </Button>
          ) : null}
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-2 scrollbar-thin">
          {groups.map(([group, items]) => (
            <div key={group} className="flex flex-col gap-1">
              {!folded ? (
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
                        folded && 'justify-center px-0',
                        isActive
                          ? 'bg-primary/12 text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    {!folded ? <span className="truncate">{item.label}</span> : null}
                    {!folded && item.to === '/jobs' && activeJobs > 0 ? (
                      <Badge variant="primary" className="ml-auto">
                        {activeJobs}
                      </Badge>
                    ) : null}
                  </NavLink>
                );
                // A collapsed rail is unusable without labels on hover.
                return folded ? (
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

        <div className={cn('border-t border-border py-3', folded ? 'px-2' : 'px-3')}>
          <ResourceMeters resources={status?.resources} collapsed={folded} />
        </div>

        {drawer ? null : (
          <div className="border-t border-border p-2">
            <Button
              variant="ghost"
              size={folded ? 'icon' : 'sm'}
              className={cn('w-full text-muted-foreground', folded && 'w-full')}
              onClick={() => setCollapsed((value) => !value)}
              aria-label={folded ? 'Expand navigation' : 'Collapse navigation'}
            >
              <ChevronLeft className={cn('transition-transform', folded && 'rotate-180')} />
              {!folded ? <span>Collapse</span> : null}
            </Button>
          </div>
        )}
    </>
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200 md:flex',
          collapsed ? 'w-[60px]' : 'w-[212px]',
        )}
      >
        {navigation(collapsed, false)}
      </aside>

      {drawer ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setDrawer(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 flex w-[min(80vw,260px)] flex-col border-r border-border bg-card shadow-2xl">
            {navigation(false, true)}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-2 sm:gap-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            <h1 className="truncate text-sm font-semibold capitalize">
              {/* The nav's own label where there is one: "LoRAs", not "Loras". */}
              {nav.find((item) => item.to === `/${location.pathname.split('/')[1]}`)?.label ?? (location.pathname.split('/')[1] || brand.home)}
            </h1>
            <BackendPills status={status} onChanged={onStatusChanged} />
          </div>

          <div className="flex items-center gap-1">
            <Tooltip label="Model catalogue and downloads">
              <Button variant="ghost" size="sm" onClick={onOpenCatalogue}>
                <Package />
                <span className="hidden sm:inline">{catalogueLabel}</span>
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

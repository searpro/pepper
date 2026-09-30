import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Relative time, which is what a job list actually wants to show. */
export function timeAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 0 || delta < 5000) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * What a backend's status pill should say, and how it should be coloured.
 *
 * A CLI backend has no long-running process, so its `status` is permanently
 * `stopped` — sd-cli is spawned per generation and exits. Reading a pill
 * straight off that made stable-diffusion.cpp look broken whenever it was
 * merely idle, which is always. For a CLI, being installed *is* being ready.
 * Both the header pills and the Preferences panel go through this, so the two
 * cannot disagree again.
 */
export function backendState(backend: {
  kind: 'server' | 'cli';
  status: string;
  installed: boolean;
}): { state: string; label: string; variant: 'success' | 'destructive' | 'warning' | 'outline' } {
  const state =
    backend.kind === 'cli' ? (backend.installed ? 'ready' : 'not installed') : backend.status;
  const label =
    backend.kind === 'cli'
      ? backend.installed
        ? 'installed — runs per generation'
        : 'not installed'
      : backend.status;
  const variant =
    state === 'ready'
      ? ('success' as const)
      : state === 'failed' || state === 'unhealthy'
        ? ('destructive' as const)
        : state === 'starting' || state === 'installing'
          ? ('warning' as const)
          : ('outline' as const);
  return { state, label, variant };
}

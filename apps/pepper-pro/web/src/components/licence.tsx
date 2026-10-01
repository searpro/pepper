import { Badge } from '@pepper/ui/components/ui';
import type { Licence } from '@/lib/pro';

const COMMERCIAL: Record<Licence['commercial'], { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  yes: { label: 'Commercial use', variant: 'success' },
  'under-1M': { label: 'Commercial under $1M', variant: 'warning' },
  'under-10M': { label: 'Commercial under $10M', variant: 'warning' },
  'under-20M': { label: 'Commercial under $20M', variant: 'warning' },
  no: { label: 'Non-commercial', variant: 'destructive' },
};

/** What a recipe's weights allow, at a glance. */
export function LicenceBadge({ licence }: { licence: Licence }) {
  const { label, variant } = COMMERCIAL[licence.commercial];
  const excluded = licence.excluded_territories.length ? ` · not ${licence.excluded_territories.join('/')}` : '';
  return (
    <Badge variant={variant} title={licence.name}>
      {label}
      {excluded}
    </Badge>
  );
}

/**
 * The attribution a licence requires in the interface (MiniMax H3's licence
 * asks commercial products to show its name), shown wherever that recipe's
 * output is.
 */
export function LicenceNotice({ licence }: { licence: Licence | undefined }) {
  if (!licence?.ui_notice) return null;
  return <p className="text-[11px] text-muted-foreground">Made with {licence.ui_notice}</p>;
}

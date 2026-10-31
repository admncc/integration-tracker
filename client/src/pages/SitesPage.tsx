import { Link, useSearchParams } from 'react-router-dom';
import Prospects from './Prospects';
import Sites from './Sites';

/**
 * The Sites area has two tabs: candidates first, then the domains being rolled
 * out - the order a domain travels in.
 *
 * The tab lives in the URL (`?view=potentials`) so the nav link can open the
 * first one while every existing link into the sites table - the header's
 * "N domains of yours", a filtered view somebody shared - still lands there,
 * because those carry no `view` at all.
 */
const TABS = [
  { key: 'potentials', label: 'Potential Sites' },
  { key: 'sites', label: 'Sites in integration process' },
] as const;

export default function SitesPage() {
  const [params] = useSearchParams();
  const view = params.get('view') === 'potentials' ? 'potentials' : 'sites';

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-line" aria-label="Sites sections">
        {TABS.map((tab) => {
          const active = view === tab.key;
          return (
            <Link
              key={tab.key}
              to={tab.key === 'potentials' ? '/sites?view=potentials' : '/sites'}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                active ? 'border-brand text-brand-ink' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {view === 'potentials' ? <Prospects /> : <Sites />}
    </div>
  );
}

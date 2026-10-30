import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session';
import { Spinner } from './components/ui';
import Inbox from './components/Inbox';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SitesPage from './pages/SitesPage';
import SiteDetail from './pages/SiteDetail';
import Issues from './pages/Issues';
import IssueDetail from './pages/IssueDetail';
import Settings from './pages/Settings';
import Account from './pages/Account';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/sites?view=potentials', label: 'Sites' },
  { to: '/issues', label: 'Issues' },
  // Settings is admin only; it holds users, the exchange rate and the importer.
  { to: '/settings', label: 'Settings', adminOnly: true },
];

export default function App() {
  const { user, loading, signOut } = useSession();

  if (loading) return <Spinner />;
  if (!user) return <Login />;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid size-6 place-items-center rounded bg-brand text-xs text-white">IT</span>
            <span className="text-sm">Integration Tracker</span>
          </div>

          <nav className="flex items-center gap-1">
            {NAV.filter((item) => !item.adminOnly || user.role === 'admin').map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-lg px-2.5 py-1.5 text-sm font-medium transition ${
                    isActive ? 'bg-brand-soft text-brand-ink' : 'text-ink-soft hover:bg-raised hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <Inbox />
            <NavLink to="/account" className="rounded-lg px-2 py-1 text-right leading-tight transition hover:bg-raised">
              <div className="font-medium">{user.name}</div>
              <div className="text-xs text-ink-faint">
                {user.company || user.role} · {user.role}
              </div>
            </NavLink>
            <button onClick={signOut} className="rounded-lg px-2.5 py-1.5 text-sm text-ink-soft hover:bg-raised hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/sites/:id" element={<SiteDetail />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/issues/:id" element={<IssueDetail />} />
          <Route path="/account" element={<Account />} />
          {/* A non-admin reaching this by hand is sent home rather than shown a page that 403s. */}
          <Route path="/settings" element={user.role === 'admin' ? <Settings /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

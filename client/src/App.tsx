import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { Spinner } from './components/ui';
import Inbox from './components/Inbox';
import { Logo } from './components/Logo';
import Login from './pages/Login';
import Unsubscribe from './pages/Unsubscribe';
import Dashboard from './pages/Dashboard';
import SitesPage from './pages/SitesPage';
import SiteDetail from './pages/SiteDetail';
import Issues from './pages/Issues';
import IssueDetail from './pages/IssueDetail';
import Settings from './pages/Settings';
import Account from './pages/Account';
import Log from './pages/Log';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/sites?view=potentials', label: 'Sites' },
  { to: '/issues', label: 'Issues' },
  // Settings is admin only; it holds users, the exchange rate and the importer.
  { to: '/log', label: 'Log', adminOnly: true },
  { to: '/settings', label: 'Settings', adminOnly: true },
];

export default function App() {
  const { user, loading, signOut } = useSession();
  const location = useLocation();

  // Reached from an e-mail, on whatever device it was read on: no sign-in needed.
  if (location.pathname === '/unsubscribe') return <Unsubscribe />;
  if (loading) return <Spinner />;
  if (!user) return <Login />;

  // The Sites tabs keep their top in place and scroll only the table (see `pinned` in index.css).
  const pinned = location.pathname === '/sites';

  return (
    <div className={`flex min-h-full flex-col ${pinned ? 'pinned:h-dvh' : ''}`}>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link to="/" aria-label="Integration Tracker - dashboard" className="rounded-lg">
            <Logo />
          </Link>

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

          <div className="ml-auto flex min-w-0 items-center gap-3 text-sm">
            <Inbox />
            <NavLink to="/account" className="min-w-0 rounded-lg px-2 py-1 text-right leading-tight transition hover:bg-raised">
              <div className="truncate font-medium">{user.name}</div>
              <div className="truncate text-xs text-ink-faint">
                {user.company || user.role} · {user.role}
              </div>
            </NavLink>
            <button onClick={signOut} className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm text-ink-soft hover:bg-raised hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 ${pinned ? 'pinned:flex pinned:min-h-0 pinned:flex-col pinned:overflow-y-auto' : ''}`}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/sites/:id" element={<SiteDetail />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/issues/:id" element={<IssueDetail />} />
          <Route path="/account" element={<Account />} />
          {/* A non-admin reaching this by hand is sent home rather than shown a page that 403s. */}
          <Route path="/settings" element={user.role === 'admin' ? <Settings /> : <Navigate to="/" replace />} />
          <Route path="/log" element={user.role === 'admin' ? <Log /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

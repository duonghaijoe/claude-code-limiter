import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface SidebarProps {
  userEmail: string;
  userName: string;
  open: boolean;
  onClose: () => void;
}

const navItems = [
  { to: '/dashboard/users', label: 'Users' },
  { to: '/dashboard/tiers', label: 'Tiers' },
  { to: '/dashboard/pools', label: 'Pools' },
  { to: '/dashboard/subscriptions', label: 'Subscriptions' },
  { to: '/dashboard/events', label: 'Events' },
];

export function Sidebar({ userEmail, userName, open, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const handleLogout = () => {
    api.logout();
    navigate('/dashboard/login');
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />
      )}
      <aside
        className={`
          fixed top-0 left-0 h-full w-64 bg-zinc-950 border-r border-zinc-800 z-50
          flex flex-col
          transition-transform duration-200 ease-out
          lg:translate-x-0 lg:static lg:z-auto
          ${open ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="px-5 py-5 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">
              QE
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-zinc-100 truncate">QE Portal</div>
              <div className="text-[10px] text-zinc-500 truncate">{userName || userEmail}</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-100 ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-zinc-800">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors duration-100 w-full cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}

export function HamburgerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="lg:hidden p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
      aria-label="Open menu"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 5h14M3 10h14M3 15h14" />
      </svg>
    </button>
  );
}

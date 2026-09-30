import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, 
  GitBranch, 
  Play, 
  Lightbulb,
  Settings,
  ShoppingBag,
  LogOut
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/workflows', icon: GitBranch, label: 'Workflows' },
  { to: '/runs', icon: Play, label: 'Runs' },
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/shopify-hub', icon: ShoppingBag, label: 'Shopify Hub' },
];

export default function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="w-64 bg-gray-900 text-white flex flex-col h-screen fixed left-0 top-0">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-gray-800">
        <LayoutDashboard className="w-4 h-4 text-primary-400 mr-2" />
        <span className="font-semibold text-lg">Workflow Engine</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-6">
        <ul className="space-y-2">
          {navItems.map(({ to, icon: Icon, label, disabled }) => (
            <li key={to}>
              {disabled ? (
                <span className="flex items-center px-4 py-2.5 text-gray-500 cursor-not-allowed">
                  <Icon className="w-5 h-5 mr-3" />
                  {label}
                </span>
              ) : (
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center px-4 py-2.5 rounded-lg transition-colors',
                      isActive
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    )
                  }
                >
                  <Icon className="w-5 h-5 mr-3" />
                  {label}
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-gray-800 text-xs flex flex-col gap-2">
        <button 
          onClick={logout}
          className="flex items-center text-red-400 hover:text-red-300 transition-colors text-sm font-medium py-1.5 px-3 rounded-md hover:bg-red-500/10"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Logout
        </button>
        <div className="text-gray-500 px-3">DSL Engine v1.0</div>
      </div>
    </aside>
  );
}

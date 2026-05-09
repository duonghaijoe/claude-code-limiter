import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { useToast } from './hooks/useToast';
import { Sidebar, HamburgerButton } from './components/Sidebar';
import { ToastContainer } from './components/Toast';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { TiersPage } from './pages/TiersPage';
import { PoolsPage } from './pages/PoolsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { EventsPage } from './pages/EventsPage';
import { ChatLayout } from './pages/chat/ChatLayout';
import { useState } from 'react';

function AuthenticatedLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { toasts, showToast, removeToast } = useToast();
  const navigate = useNavigate();
  const stored = api.getStoredUser();

  useEffect(() => {
    api.setUnauthorizedHandler(() => navigate('/dashboard/login', { replace: true }));
  }, [navigate]);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      <Sidebar
        userEmail={stored?.email ?? ''}
        userName={stored?.name ?? ''}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-950 sticky top-0 z-30">
          <HamburgerButton onClick={() => setSidebarOpen(true)} />
          <span className="text-sm font-semibold text-zinc-300">QE Portal Admin</span>
          <div className="w-8" />
        </div>

        <div className="p-6 lg:p-8 max-w-7xl mx-auto">
          <Routes>
            <Route index element={<Navigate to="users" replace />} />
            <Route path="users" element={<UsersPage showToast={showToast} />} />
            <Route path="tiers" element={<TiersPage showToast={showToast} />} />
            <Route path="pools" element={<PoolsPage showToast={showToast} />} />
            <Route path="subscriptions" element={<SubscriptionsPage showToast={showToast} />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="*" element={<Navigate to="users" replace />} />
          </Routes>
        </div>
      </main>

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!api.isAuthenticated()) {
    return <Navigate to="/dashboard/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const stored = api.getStoredUser();
  if (stored && stored.role !== 'admin') {
    return <Navigate to="/chat" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/dashboard/login" element={<LoginPage />} />
      <Route
        path="/dashboard/*"
        element={
          <AuthGuard>
            <AdminGuard>
              <AuthenticatedLayout />
            </AdminGuard>
          </AuthGuard>
        }
      />
      <Route
        path="/chat/*"
        element={
          <AuthGuard>
            <ChatLayout />
          </AuthGuard>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard/" replace />} />
    </Routes>
  );
}

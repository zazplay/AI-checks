import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import axios from 'axios';
import { invoiceKeys } from '../hooks/useInvoices';
import { api, getToken, http, setToken } from '../lib/api';
import { connectSocket, disconnectSocket } from '../lib/socket';
import type { Invoice } from '../types/invoice';

type AuthStatus = 'checking' | 'unauthenticated' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('checking');
  const statusRef = useRef(status);
  statusRef.current = status;

  const logout = useCallback(() => {
    setToken(null);
    disconnectSocket();
    qc.clear();
    setStatus('unauthenticated');
  }, [qc]);

  // Probe on mount. Only a 401 means "show the login screen": it covers both
  // a missing and a stale stored key, and also lets the app skip login
  // entirely when the backend runs with auth disabled (no API_KEY set).
  // Non-auth failures (backend down) fall through to the app, which already
  // surfaces them.
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void (async () => {
      try {
        const invoices = await api.listInvoices();
        qc.setQueryData(invoiceKeys.all, invoices);
        setStatus('authenticated');
        connectSocket(getToken());
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          setToken(null);
          setStatus('unauthenticated');
        } else {
          setStatus('authenticated');
          connectSocket(getToken());
        }
      }
    })();
  }, [qc]);

  // Any 401 while inside the app boots back to the login screen.
  useEffect(() => {
    const id = http.interceptors.response.use(undefined, (error) => {
      if (
        axios.isAxiosError(error) &&
        error.response?.status === 401 &&
        statusRef.current === 'authenticated'
      ) {
        notifications.show({
          color: 'red',
          title: 'Signed out',
          message: 'The API key was rejected by the server.',
        });
        logout();
      }
      return Promise.reject(error);
    });
    return () => http.interceptors.response.eject(id);
  }, [logout]);

  const login = useCallback(
    async (username: string, password: string) => {
      const { accessToken } = await api.login(username.trim(), password);
      setToken(accessToken);
      connectSocket(accessToken);
      try {
        // Seed the list so the app opens with data already in place.
        qc.setQueryData<Invoice[]>(invoiceKeys.all, await api.listInvoices());
      } catch {
        // Not fatal — the app surfaces list errors itself.
      }
      setStatus('authenticated');
    },
    [qc],
  );

  return (
    <AuthContext.Provider value={{ status, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as api from './chatApi';
import {
  clearIdentity,
  generateIdentity,
  loadIdentity,
  saveIdentity,
  unwrapIdentity,
  wrapIdentity,
} from './e2ee';
import { disconnectSocket, updateSocketToken } from './socket';
import type { User } from './types';

type E2eState = 'loading' | 'ready' | 'locked';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  e2eState: E2eState;
  login: (identifier: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  unlockE2EE: (password: string) => Promise<boolean>;
  updateProfile: (patch: { avatarUrl: string | null }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [e2eState, setE2eState] = useState<E2eState>('loading');
  const userRef = useRef<User | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    const unsubscribe = api.onAccessTokenChange(() => {
      const token = api.getAccessToken();
      if (token) {
        updateSocketToken(token);
      }
    });
    return unsubscribe;
  }, []);

  /**
   * Ensures the device holds a usable E2EE identity for the user.
   * - With a password (fresh login/register): unwraps the server bundle, or
   *   generates + uploads a new one (first login, or after an admin reset
   *   invalidated the old bundle).
   * - Without a password (session restore): only checks local storage; if the
   *   key isn't on this device the state becomes "locked" and the user must
   *   re-enter their password.
   */
  const initE2EE = useCallback(async (target: User, password: string | null) => {
    if (!password) {
      setE2eState(loadIdentity(target.id) ? 'ready' : 'locked');
      return;
    }

    const local = loadIdentity(target.id);
    try {
      const bundle = await api.getMyE2eKey();

      if (local && bundle.publicKey === local.publicKey) {
        setE2eState('ready');
        return;
      }
      if (bundle.publicKey && bundle.wrappedKey && bundle.kekSalt && bundle.kekParams) {
        const unwrapped = await unwrapIdentity(password, {
          publicKey: bundle.publicKey,
          wrappedKey: bundle.wrappedKey,
          kekSalt: bundle.kekSalt,
          kekParams: bundle.kekParams,
        });
        if (unwrapped) {
          saveIdentity(target.id, unwrapped);
          setE2eState('ready');
          return;
        }
      }

      // No server key yet, or the bundle no longer matches the password
      // (admin reset) — rotate: fresh keypair wrapped with the current password.
      const fresh = await generateIdentity(password);
      await api.putMyE2eKey(fresh.bundle);
      saveIdentity(target.id, fresh.identity);
      setE2eState('ready');
    } catch (err) {
      console.error('E2EE bootstrap failed', err);
      setE2eState(loadIdentity(target.id) ? 'ready' : 'locked');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const session = await api.refreshSession();
      if (cancelled) return;
      if (session) {
        setUser(session.user);
        await initE2EE(session.user, null);
      } else if (api.getAccessToken()) {
        try {
          const me = await api.fetchMe();
          if (cancelled) return;
          setUser(me);
          await initE2EE(me, null);
        } catch {
          api.clearSessionTokens();
          setUser(null);
          setE2eState('loading');
        }
      } else {
        setE2eState('loading');
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [initE2EE]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const data = await api.login(identifier, password);
      setUser(data.user);
      await initE2EE(data.user, password);
    },
    [initE2EE],
  );

  const register = useCallback(
    async (username: string, email: string, password: string) => {
      const data = await api.register(username, email, password);
      setUser(data.user);
      await initE2EE(data.user, password);
    },
    [initE2EE],
  );

  const logout = useCallback(async () => {
    disconnectSocket();
    const current = userRef.current;
    await api.logout();
    if (current) clearIdentity(current.id);
    setUser(null);
    setE2eState('loading');
  }, []);

  const unlockE2EE = useCallback(async (password: string) => {
    const current = userRef.current;
    if (!current) return false;
    try {
      const bundle = await api.getMyE2eKey();
      if (!bundle.publicKey || !bundle.wrappedKey || !bundle.kekSalt || !bundle.kekParams) return false;
      const identity = await unwrapIdentity(password, {
        publicKey: bundle.publicKey,
        wrappedKey: bundle.wrappedKey,
        kekSalt: bundle.kekSalt,
        kekParams: bundle.kekParams,
      });
      if (!identity) return false;
      saveIdentity(current.id, identity);
      setE2eState('ready');
      return true;
    } catch {
      return false;
    }
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.changePassword(currentPassword, newPassword);

      // The wrapped private key was derived from the old password — re-wrap
      // it under the new one, or the next login would treat it as a key
      // rotation and lose access to existing DM history.
      const current = userRef.current;
      if (!current) return;

      let identity = loadIdentity(current.id);
      if (!identity) {
        try {
          const bundle = await api.getMyE2eKey();
          if (bundle.publicKey && bundle.wrappedKey && bundle.kekSalt && bundle.kekParams) {
            identity = await unwrapIdentity(currentPassword, {
              publicKey: bundle.publicKey,
              wrappedKey: bundle.wrappedKey,
              kekSalt: bundle.kekSalt,
              kekParams: bundle.kekParams,
            });
          }
        } catch {
          // fall through
        }
      }
      if (!identity) return;

      try {
        const bundle = await wrapIdentity(identity, newPassword);
        await api.putMyE2eKey(bundle);
        saveIdentity(current.id, identity);
        setE2eState('ready');
      } catch (err) {
        console.error('Failed to re-wrap E2EE key after password change', err);
      }
    },
    [],
  );

  const updateProfile = useCallback(async (patch: { avatarUrl: string | null }) => {
    const avatarUrl = await api.setUserAvatar(patch.avatarUrl);
    setUser((prev) => (prev ? { ...prev, avatarUrl } : prev));
  }, []);

  const value = useMemo(
    () => ({ user, loading, e2eState, login, register, logout, changePassword, unlockE2EE, updateProfile }),
    [user, loading, e2eState, login, register, logout, changePassword, unlockE2EE, updateProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

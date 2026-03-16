/**
 * AuthContext — global authentication + credit state.
 *
 * Provides:
 *   user        — current user object or null
 *   token       — JWT string or null
 *   creditBalance — current credit balance (number)
 *   login(token)  — store JWT + fetch profile
 *   logout()      — clear all auth state
 *   refreshBalance() — re-fetch credit balance from API
 *   isLoading   — true while initial session is being restored
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api from '../utils/api';

const AuthContext = createContext(null);

const TOKEN_KEY = 'auth_token';

export function AuthProvider({ children }) {
  const [user, setUser]                   = useState(null);
  const [token, setToken]                 = useState(() => localStorage.getItem(TOKEN_KEY));
  const [creditBalance, setCreditBalance] = useState(null);
  const [usedThisMonth, setUsedThisMonth] = useState(0);
  const [isLoading, setIsLoading]         = useState(true);

  // Attach / detach Authorization header on every axios request
  useEffect(() => {
    const id = api.interceptors.request.use((config) => {
      const t = localStorage.getItem(TOKEN_KEY);
      if (t) config.headers.Authorization = `Bearer ${t}`;
      return config;
    });
    return () => api.interceptors.request.eject(id);
  }, []);

  // Auto-logout on 401 responses
  useEffect(() => {
    const id = api.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response?.status === 401) {
          logout(); // eslint-disable-line no-use-before-define
        }
        return Promise.reject(err);
      },
    );
    return () => api.interceptors.response.eject(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshBalance = useCallback(async () => {
    try {
      const { data } = await api.get('/v1/credits/balance');
      setCreditBalance(data.balance);
      setUsedThisMonth(data.used_this_month ?? 0);
    } catch {
      // ignore — could be unauthenticated
    }
  }, []);

  const login = useCallback(async (jwt) => {
    localStorage.setItem(TOKEN_KEY, jwt);
    setToken(jwt);
    try {
      const { data: profile } = await api.get('/v1/auth/me', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      setUser(profile);
      setCreditBalance(profile.credit_balance);
      // Fetch detailed balance (includes used_this_month)
      const { data: bal } = await api.get('/v1/credits/balance', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      setCreditBalance(bal.balance);
      setUsedThisMonth(bal.used_this_month ?? 0);
    } catch {
      // token invalid
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setCreditBalance(null);
    setUsedThisMonth(0);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      login(savedToken).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider
      value={{ user, token, creditBalance, usedThisMonth, isLoading, login, logout, refreshBalance }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default AuthContext;

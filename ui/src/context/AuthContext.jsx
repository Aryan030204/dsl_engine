import React, { createContext, useState, useEffect, useContext } from 'react';
import api, { SESSION_EXPIRED_EVENT } from '../api/client';
import { toast } from 'react-hot-toast';

const AuthContext = createContext();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries when the API can't be reached or fails (it restarts, the database is slow): those say nothing
// about whether the user is signed in. Only a 401 means "not signed in".
const SESSION_CHECK_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // true when the session check could not be completed (server unreachable), as opposed to "signed out"
  const [authUnavailable, setAuthUnavailable] = useState(false);

  // Check if user is logged in on mount
  useEffect(() => {
    checkUserLoggedIn();
  }, []);

  // A request made while signed in came back 401: the session ended.
  useEffect(() => {
    const onSessionExpired = () => {
      setUser((current) => {
        if (current) toast.error('Your session has expired. Please sign in again.');
        return null;
      });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, []);

  const checkUserLoggedIn = async () => {
    setLoading(true);
    setAuthUnavailable(false);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const { data } = await api.get('/auth/me');
        setUser(data);
        break;
      } catch (err) {
        if (err.response?.status === 401) {
          // Genuinely not signed in.
          setUser(null);
          break;
        }
        if (attempt >= SESSION_CHECK_RETRY_DELAYS_MS.length) {
          // Still failing after retries: don't pretend the user is signed out.
          setAuthUnavailable(true);
          break;
        }
        await wait(SESSION_CHECK_RETRY_DELAYS_MS[attempt]);
      }
    }
    setLoading(false);
  };

  const login = async (email, password) => {
    try {
      const { data } = await api.post('/auth/login', { email, password });
      setUser(data.user);
      toast.success('Logged in successfully');
      return { success: true };
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Login failed';
      toast.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  };

  const signup = async (name, email, password) => {
    try {
      const { data } = await api.post('/auth/signup', { name, email, password });
      setUser(data.user);
      toast.success('Account created successfully');
      return { success: true };
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Signup failed';
      toast.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  };

  const googleLogin = async (idToken) => {
    try {
      const { data } = await api.post('/auth/google', { idToken });
      setUser(data.user);
      toast.success('Logged in with Google');
      return { success: true };
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Google login failed';
      toast.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
      setUser(null);
      toast.success('Logged out');
    } catch (err) {
      toast.error('Logout failed');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, authUnavailable, retryAuth: checkUserLoggedIn, login, signup, googleLogin, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

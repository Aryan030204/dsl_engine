import React, { createContext, useState, useEffect, useContext } from 'react';
import api from '../api/client';
import { toast } from 'react-hot-toast';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check if user is logged in on mount
  useEffect(() => {
    checkUserLoggedIn();
  }, []);

  const checkUserLoggedIn = async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch (err) {
      setUser(null);
    } finally {
      setLoading(false);
    }
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
    <AuthContext.Provider value={{ user, loading, login, signup, googleLogin, logout }}>
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

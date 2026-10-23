import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  withCredentials: true, // Enable sending cookies with requests
  headers: {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest', // CSRF guard: required by the API on state-changing requests
  },
});

// Request interceptor for logging
api.interceptors.request.use(
  (config) => {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => Promise.reject(error)
);

// Fired when a request made while signed in comes back 401, i.e. the session really has ended
// (expired, revoked, or the server's signing key changed). AuthContext listens and returns the user
// to the login page, instead of leaving them on a page full of failing requests.
export const SESSION_EXPIRED_EVENT = 'auth:session-expired';

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.error || error.message || 'An error occurred';
    console.error('[API Error]', message);

    const url = String(error.config?.url || '');
    // Login/signup/me answer 401 for ordinary reasons (wrong password, not signed in): AuthContext
    // handles those itself.
    if (error.response?.status === 401 && !url.startsWith('/auth/')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    return Promise.reject(error);
  }
);

export default api;

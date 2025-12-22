import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function Login() {
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, loginWithMicrosoft } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftLogin = async () => {
    setError('');
    setLoading(true);
    try {
      await loginWithMicrosoft();
      // OAuth will redirect, so we don't need to navigate here
    } catch (err: any) {
      setError(err.message || 'Microsoft login failed');
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', position: 'relative' }}>
      <button 
        className="theme-toggle" 
        onClick={toggleTheme} 
        style={{ position: 'absolute', top: '20px', right: '20px' }}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
      >
        {theme === 'light' ? '🌙' : '☀️'}
      </button>
      <div className="card" style={{ width: '400px' }}>
        <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>IONEX Time Tracking</h2>
        <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>Login</h3>
        
        {error && <div className="error" style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#fee', color: '#c33', borderRadius: '4px' }}>{error}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          
          <div className="form-group">
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          
          <button
            type="submit"
            className="button button-primary"
            style={{ width: '100%', marginBottom: '15px' }}
            disabled={loading}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border)' }}>
          <p style={{ marginBottom: '15px', color: 'var(--text-secondary)' }}>Or sign in with</p>
          <button
            type="button"
            className="button"
            style={{ width: '100%' }}
            onClick={handleMicrosoftLogin}
            disabled={loading}
          >
            🔷 Microsoft / Office 365
          </button>
        </div>
      </div>
    </div>
  );
}

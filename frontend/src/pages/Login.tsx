import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function Login() {
  const { theme, toggleTheme } = useTheme();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, signUp } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (isSignUp) {
        await signUp(email, password, firstName, lastName);
        setSuccess('Account created successfully! Please check your email to confirm your account before logging in.');
        // Reset form
        setEmail('');
        setPassword('');
        setFirstName('');
        setLastName('');
        setIsSignUp(false);
      } else {
        await login(email, password);
        navigate('/dashboard');
      }
    } catch (err: any) {
      setError(err.message || (isSignUp ? 'Sign up failed' : 'Login failed'));
    } finally {
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
        <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>
          {isSignUp ? 'Create Account' : 'Login'}
        </h3>
        
        {error && <div className="error" style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#fee', color: '#c33', borderRadius: '4px' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#efe', color: '#3c3', borderRadius: '4px' }}>{success}</div>}
        
        <form onSubmit={handleSubmit}>
          {isSignUp && (
            <>
              <div className="form-group">
                <label className="label">First Name</label>
                <input
                  type="text"
                  className="input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required={isSignUp}
                />
              </div>
              
              <div className="form-group">
                <label className="label">Last Name</label>
                <input
                  type="text"
                  className="input"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required={isSignUp}
                />
              </div>
            </>
          )}
          
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
              minLength={6}
            />
            {isSignUp && (
              <small style={{ color: 'var(--text-tertiary)', fontSize: '12px', display: 'block', marginTop: '4px' }}>
                Password must be at least 6 characters
              </small>
            )}
          </div>
          
          <button
            type="submit"
            className="button button-primary"
            style={{ width: '100%', marginBottom: '15px' }}
            disabled={loading}
          >
            {loading 
              ? (isSignUp ? 'Creating account...' : 'Logging in...') 
              : (isSignUp ? 'Create Account' : 'Login')
            }
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
          <p style={{ marginBottom: '10px', color: 'var(--text-secondary)' }}>
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}
          </p>
          <button
            type="button"
            className="button"
            style={{ width: '100%', backgroundColor: 'transparent', border: '1px solid var(--border-color)' }}
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError('');
              setSuccess('');
              setEmail('');
              setPassword('');
              setFirstName('');
              setLastName('');
            }}
            disabled={loading}
          >
            {isSignUp ? 'Login instead' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}

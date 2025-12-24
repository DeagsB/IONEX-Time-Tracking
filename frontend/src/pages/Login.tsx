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
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Login.tsx:26',message:'UI signUp attempt',data:{email,emailDomain:email.split('@')[1],hasFirstName:!!firstName,hasLastName:!!lastName},timestamp:Date.now(),sessionId:'debug-session',runId:'initial',hypothesisId:'A,B,C'})}).catch(()=>{});
        // #endregion
        
        await signUp(email, password, firstName, lastName);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Login.tsx:29',message:'UI signUp succeeded',data:{email,emailDomain:email.split('@')[1]},timestamp:Date.now(),sessionId:'debug-session',runId:'initial',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        
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
      console.error('❌ Authentication error:', err);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/42154b7e-9114-4abf-aaac-8c6066245862',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Login.tsx:42',message:'UI caught error',data:{errorMessage:err.message,errorCode:err.code,errorStatus:err.status,errorName:err.name,isSignUp},timestamp:Date.now(),sessionId:'debug-session',runId:'initial',hypothesisId:'A,D'})}).catch(()=>{});
      // #endregion
      
      const errorMessage = err.message || (isSignUp ? 'Sign up failed' : 'Login failed');
      setError(errorMessage);
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

import { useState, useEffect, useRef } from 'react';
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
  const [department, setDepartment] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const { login, signUp, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);

  // Redirect if already logged in
  useEffect(() => {
    if (!authLoading && user) {
      navigate('/calendar', { replace: true });
    }
  }, [user, authLoading, navigate]);

  // Reset form validation state when success is shown
  useEffect(() => {
    if (success && formRef.current) {
      // Clear validation states for all inputs
      const inputs = formRef.current.querySelectorAll('input');
      inputs.forEach((input) => {
        input.setCustomValidity('');
        input.blur(); // Remove focus to clear any :focus validation states
      });
    }
  }, [success]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitted(true);
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (isSignUp) {
        const result = await signUp(email, password, firstName, lastName, department);
        
        if (result.needsEmailConfirmation) {
          setSuccess(
            'Account created! Please check your email (including spam folder) for a confirmation link. ' +
            'Click the link to activate your account, then you can log in. ' +
            'If you don\'t receive the email within a few minutes, check your spam folder or contact support.'
          );
        } else if (result.session) {
          // Email confirmation disabled - user is automatically logged in
          setSuccess('Account created successfully! Redirecting...');
          setTimeout(() => {
            navigate('/calendar');
          }, 1000);
          return;
        } else {
          setSuccess('Account created successfully! Please check your email to confirm your account.');
        }
        
        // Reset form
        setEmail('');
        setPassword('');
        setFirstName('');
        setLastName('');
        setDepartment('');
        setIsSignUp(false);
      } else {
        await login(email, password);
        navigate('/calendar');
      }
    } catch (err: any) {
      console.error('❌ Authentication error:', err);
      let errorMessage = err.message || (isSignUp ? 'Sign up failed' : 'Login failed');
      
      // Provide more helpful error messages
      if (err.message?.includes('already registered')) {
        errorMessage = 'This email is already registered. Please log in instead.';
      } else if (err.message?.includes('email')) {
        errorMessage = 'Invalid email address. Please check and try again.';
      } else if (err.message?.includes('password')) {
        errorMessage = 'Password must be at least 6 characters long.';
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // Show loading state while checking auth
  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-primary)' }}>
          <div style={{ fontSize: '18px', marginBottom: '10px' }}>Loading...</div>
        </div>
      </div>
    );
  }

  // Don't render if user is logged in (will redirect)
  if (user) {
    return null;
  }

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      minHeight: '100vh', 
      position: 'relative',
      background: 'linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%)',
      padding: '20px'
    }}>
      <button
        type="button"
        className="theme-toggle"
        onClick={toggleTheme}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          zIndex: 10,
          width: '64px',
          height: '32px',
          borderRadius: '16px',
          border: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.06)',
        }}
      >
        <span style={{
          position: 'absolute',
          left: '8px',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: '14px',
          opacity: theme === 'dark' ? 1 : 0.5,
          transition: 'opacity 0.2s',
          zIndex: 1,
        }}>🌙</span>
        <span style={{
          position: 'absolute',
          right: '8px',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: '14px',
          opacity: theme === 'light' ? 1 : 0.5,
          transition: 'opacity 0.2s',
          zIndex: 1,
        }}>☀️</span>
        <span style={{
          position: 'absolute',
          left: theme === 'dark' ? '4px' : 'calc(100% - 28px)',
          top: '4px',
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: 'var(--bg-primary)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          zIndex: 2,
        }} />
      </button>
      <div className="card" style={{ 
        width: '100%', 
        maxWidth: '420px',
        boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--border-color)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ 
            marginBottom: '20px',
            backgroundColor: 'transparent',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
          }}>
            <img
              src="/ionex-logo-removebg-preview.png"
              alt="IONEX Logo"
              onError={(e) => {
                console.error('Logo failed to load, trying fallback:', e.currentTarget.src);
                // Fallback to original logo if new one fails
                if (!e.currentTarget.src.includes('ionex-logo.png')) {
                  e.currentTarget.src = '/ionex-logo.png';
                }
              }}
              style={{
                maxWidth: '180px',
                height: 'auto',
                margin: '0 auto',
                display: 'block',
                borderRadius: '4px',
              }}
            />
          </div>
          <h1 style={{ 
            marginBottom: '8px', 
            fontSize: '28px',
            fontWeight: '700',
            color: 'var(--text-primary)'
          }}>
            IONEX Time Tracking
          </h1>
          <h2 style={{ 
            marginBottom: '0',
            fontSize: '20px',
            fontWeight: '500',
            color: 'var(--text-secondary)'
          }}>
            {isSignUp ? 'Create Your Account' : 'Welcome Back'}
          </h2>
        </div>
        
        {error && (
          <div className="error" style={{ 
            marginBottom: '16px', 
            padding: '12px 16px', 
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {error}
          </div>
        )}
        {success && (
          <div className="success" style={{ 
            marginBottom: '16px', 
            padding: '12px 16px', 
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {success}
          </div>
        )}
        
        <form 
          ref={formRef} 
          onSubmit={handleSubmit} 
          noValidate 
          className={`${success ? 'form-success' : ''} ${formSubmitted ? 'form-submitted' : ''}`}
        >
          {isSignUp && (
            <>
              <div className="form-group">
                <label className="label">First Name</label>
                <input
                  type="text"
                  name="firstName"
                  className="input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  onBlur={(e) => {
                    // Mark field as touched for validation styling
                    e.currentTarget.classList.add('touched');
                  }}
                  required={isSignUp && !success}
                />
              </div>
              
              <div className="form-group">
                <label className="label">Last Name</label>
                <input
                  type="text"
                  name="lastName"
                  className="input"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  onBlur={(e) => {
                    // Mark field as touched for validation styling
                    e.currentTarget.classList.add('touched');
                  }}
                  required={isSignUp && !success}
                />
              </div>
              
              <div className="form-group">
                <label className="label">Department</label>
                <select
                  name="department"
                  className="input"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  onBlur={(e) => {
                    // Mark field as touched for validation styling
                    e.currentTarget.classList.add('touched');
                  }}
                  required={isSignUp && !success}
                >
                  <option value="">Select Department</option>
                  <option value="Automation">Automation</option>
                  <option value="Panel Shop">Panel Shop</option>
                </select>
              </div>
            </>
          )}
          
          <div className="form-group">
            <label className="label">Email</label>
            <input
              type="email"
              name="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={(e) => {
                // Mark field as touched for validation styling
                e.currentTarget.classList.add('touched');
              }}
              required={!success}
            />
          </div>
          
          <div className="form-group">
            <label className="label">Password</label>
            <input
              type="password"
              name="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={(e) => {
                // Mark field as touched for validation styling
                e.currentTarget.classList.add('touched');
              }}
              required={!success}
              minLength={success ? undefined : 6}
            />
            {isSignUp && !success && (
              <small style={{ color: 'var(--text-tertiary)', fontSize: '12px', display: 'block', marginTop: '4px' }}>
                Password must be at least 6 characters
              </small>
            )}
          </div>
          
          <button
            type="submit"
            className="button button-primary"
            style={{ 
              width: '100%', 
              marginTop: '8px',
              marginBottom: '24px',
              padding: '12px 20px',
              fontSize: '16px',
              fontWeight: '600'
            }}
            disabled={loading}
          >
            {loading 
              ? (isSignUp ? 'Creating account...' : 'Logging in...') 
              : (isSignUp ? 'Create Account' : 'Sign In')
            }
          </button>
        </form>

        <div style={{ 
          textAlign: 'center', 
          marginTop: '24px', 
          paddingTop: '24px', 
          borderTop: '1px solid var(--border-color)' 
        }}>
          <p style={{ 
            marginBottom: '12px', 
            color: 'var(--text-secondary)',
            fontSize: '14px'
          }}>
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}
          </p>
          <button
            type="button"
            className="button button-secondary"
            style={{ 
              width: '100%',
              padding: '10px 20px'
            }}
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError('');
              setSuccess('');
              setFormSubmitted(false);
              setEmail('');
              setPassword('');
              setFirstName('');
              setLastName('');
              setDepartment('');
            }}
            disabled={loading}
          >
            {isSignUp ? 'Sign In instead' : 'Create New Account'}
          </button>
        </div>
      </div>
    </div>
  );
}

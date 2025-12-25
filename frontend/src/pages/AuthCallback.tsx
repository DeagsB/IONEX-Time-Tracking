import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const code = searchParams.get('code');
        
        if (!code) {
          setError('No verification code found in the URL');
          setLoading(false);
          return;
        }

        console.log('🔐 AuthCallback: Exchanging code for session...');
        
        // Exchange the code for a session
        const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

        if (exchangeError) {
          console.error('❌ AuthCallback: Error exchanging code:', exchangeError);
          setError(exchangeError.message);
          setLoading(false);
          return;
        }

        if (data.session) {
          console.log('✅ AuthCallback: Session established, redirecting to dashboard...');
          // Session established, navigate to dashboard
          // The AuthContext will pick up the session change automatically
          setTimeout(() => {
            navigate('/dashboard');
          }, 1000);
        } else {
          setError('Failed to establish session');
          setLoading(false);
        }
      } catch (err: any) {
        console.error('❌ AuthCallback: Unexpected error:', err);
        setError(err.message || 'An unexpected error occurred');
        setLoading(false);
      }
    };

    handleCallback();
  }, [searchParams, navigate]);

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      minHeight: '100vh',
      flexDirection: 'column',
      gap: '20px'
    }}>
      {loading ? (
        <>
          <div style={{ fontSize: '18px', color: 'var(--text-primary)' }}>
            Verifying your email...
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            Please wait while we complete your registration
          </div>
        </>
      ) : error ? (
        <div className="card" style={{ width: '400px', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '20px', color: '#c33' }}>Verification Failed</h2>
          <p style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>{error}</p>
          <button
            className="button button-primary"
            onClick={() => navigate('/login')}
            style={{ width: '100%' }}
          >
            Return to Login
          </button>
        </div>
      ) : (
        <div className="card" style={{ width: '400px', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '20px', color: '#3c3' }}>Email Verified!</h2>
          <p style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>
            Your account has been verified successfully. Redirecting to dashboard...
          </p>
        </div>
      )}
    </div>
  );
}




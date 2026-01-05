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
        // First, check if user is already authenticated (Supabase might have auto-authenticated)
        const { data: { session: existingSession } } = await supabase.auth.getSession();
        
        if (existingSession) {
          console.log('✅ AuthCallback: User already authenticated, redirecting...');
          setLoading(false);
          setTimeout(() => {
            navigate('/calendar');
          }, 500);
          return;
        }
        
        // Check for code in query parameters
        const code = searchParams.get('code');
        
        // Also check hash fragment (Supabase sometimes uses #access_token=...)
        const hash = window.location.hash;
        const hashParams = new URLSearchParams(hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');
        
        console.log('🔐 AuthCallback: Checking verification parameters...', {
          hasCode: !!code,
          hasAccessToken: !!accessToken,
          hasRefreshToken: !!refreshToken,
          url: window.location.href
        });
        
        // Try to exchange code for session
        if (code) {
          console.log('🔐 AuthCallback: Exchanging code for session...');
          
          const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

          if (exchangeError) {
            console.error('❌ AuthCallback: Error exchanging code:', exchangeError);
            // Don't set error immediately - check if tokens in hash work or if already authenticated
            if (!accessToken) {
              // Wait a moment and check session again (Supabase might process async)
              await new Promise(resolve => setTimeout(resolve, 500));
              const { data: { session: retrySession } } = await supabase.auth.getSession();
              if (retrySession) {
                console.log('✅ AuthCallback: Session established after retry, redirecting...');
                setLoading(false);
                setTimeout(() => {
                  navigate('/calendar');
                }, 500);
                return;
              }
              setError(exchangeError.message);
              setLoading(false);
              return;
            }
          } else if (data.session) {
            console.log('✅ AuthCallback: Session established via code exchange, redirecting...');
            setLoading(false);
            setTimeout(() => {
              navigate('/calendar');
            }, 500);
            return;
          }
        }
        
        // Try to use tokens from hash fragment
        if (accessToken && refreshToken) {
          console.log('🔐 AuthCallback: Setting session from hash tokens...');
          const { data, error: tokenError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          
          if (tokenError) {
            console.error('❌ AuthCallback: Error setting session from tokens:', tokenError);
            setError(tokenError.message);
            setLoading(false);
            return;
          }
          
          if (data.session) {
            console.log('✅ AuthCallback: Session established via hash tokens, redirecting...');
            setLoading(false);
            setTimeout(() => {
              navigate('/calendar');
            }, 500);
            return;
          }
        }
        
        // If no code or tokens found, wait a moment for Supabase to process (it might be async)
        if (!code && !accessToken) {
          console.log('⚠️ AuthCallback: No code or tokens found, waiting for async processing...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Final check - maybe session was established asynchronously
          const { data: { session: finalSession } } = await supabase.auth.getSession();
          if (finalSession) {
            console.log('✅ AuthCallback: Session found after wait, redirecting...');
            setLoading(false);
            setTimeout(() => {
              navigate('/calendar');
            }, 500);
            return;
          }
          
          // If still no session, show error but allow login (account might already be created)
          console.warn('⚠️ AuthCallback: No session found, but account may already be verified');
          setError('Verification link may have already been used, or the link has expired. Please try logging in.');
          setLoading(false);
          return;
        }
        
        // Final check after all attempts
        await new Promise(resolve => setTimeout(resolve, 500));
        const { data: { session: finalSession } } = await supabase.auth.getSession();
        if (finalSession) {
          console.log('✅ AuthCallback: Session found on final check, redirecting...');
          setLoading(false);
          setTimeout(() => {
            navigate('/calendar');
          }, 500);
        } else {
          setError('Failed to establish session. Your account may already be verified - please try logging in.');
          setLoading(false);
        }
      } catch (err: any) {
        console.error('❌ AuthCallback: Unexpected error:', err);
        setError(err.message || 'An unexpected error occurred. Please try logging in.');
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
            Your account has been verified successfully. Redirecting to calendar...
          </p>
        </div>
      )}
    </div>
  );
}







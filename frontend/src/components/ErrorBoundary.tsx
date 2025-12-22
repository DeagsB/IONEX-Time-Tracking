import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';

function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  return (
    <div role="alert" style={{ 
      padding: '40px', 
      fontFamily: 'system-ui, sans-serif',
      minHeight: '100vh',
      backgroundColor: '#fff',
      color: '#000'
    }}>
      <h2 style={{ color: '#ef4444', marginBottom: '20px', fontSize: '24px' }}>Something went wrong:</h2>
      <pre style={{ 
        backgroundColor: '#fee2e2', 
        padding: '15px', 
        borderRadius: '4px',
        overflow: 'auto',
        fontSize: '12px',
        color: '#991b1b'
      }}>
        {error.message}
      </pre>
      {error.stack && (
        <details style={{ marginTop: '10px' }}>
          <summary style={{ cursor: 'pointer', color: '#475569' }}>Stack trace</summary>
          <pre style={{ 
            backgroundColor: '#f1f5f9', 
            padding: '10px', 
            borderRadius: '4px',
            overflow: 'auto',
            fontSize: '11px',
            marginTop: '5px'
          }}>
            {error.stack}
          </pre>
        </details>
      )}
      <button 
        onClick={resetErrorBoundary}
        style={{
          marginTop: '15px',
          padding: '8px 16px',
          backgroundColor: '#dc2626',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        Try again
      </button>
    </div>
  );
}

export default function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      {children}
    </ErrorBoundary>
  );
}


import React from 'react';

const Maintenance: React.FC = () => {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        padding: '20px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          maxWidth: '500px',
          padding: '40px',
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: '12px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
        }}
      >
        <div style={{ fontSize: '64px', marginBottom: '20px' }}>
          🔧
        </div>
        <h1
          style={{
            fontSize: '28px',
            fontWeight: '700',
            marginBottom: '16px',
            color: 'var(--primary-color)',
          }}
        >
          Application Under Maintenance
        </h1>
        <p
          style={{
            fontSize: '16px',
            color: 'var(--text-secondary)',
            lineHeight: '1.6',
            marginBottom: '24px',
          }}
        >
          We're currently performing scheduled maintenance to improve your experience.
          Please check back shortly.
        </p>
        <div
          style={{
            padding: '16px',
            backgroundColor: 'var(--bg-primary)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
          }}
        >
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>
            If you have urgent questions, please contact your administrator.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Maintenance;

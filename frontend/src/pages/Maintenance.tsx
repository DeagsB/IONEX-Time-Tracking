import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const Maintenance: React.FC = () => {
  const { isAdmin, maintenanceMode, setMaintenanceMode } = useAuth();
  const navigate = useNavigate();

  const handleTurnOff = () => {
    setMaintenanceMode(false);
    navigate('/calendar');
  };

  const handleTurnOn = () => {
    setMaintenanceMode(true);
  };

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

        {isAdmin && (
          <div
            style={{
              marginTop: '28px',
              paddingTop: '24px',
              borderTop: '1px solid var(--border-color)',
            }}
          >
            <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '12px' }}>
              Admin: Maintenance mode is currently <strong>{maintenanceMode ? 'ON' : 'OFF'}</strong>
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {maintenanceMode ? (
                <button
                  type="button"
                  onClick={handleTurnOff}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: '600',
                    color: 'white',
                    backgroundColor: '#10b981',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                >
                  Turn maintenance mode OFF
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleTurnOn}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: '600',
                    color: 'white',
                    backgroundColor: '#f59e0b',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                >
                  Turn maintenance mode ON
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Maintenance;

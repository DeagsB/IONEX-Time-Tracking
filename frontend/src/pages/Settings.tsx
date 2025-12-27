import { useDemoMode } from '../context/DemoModeContext';

export default function Settings() {
  const { isDemoMode, toggleDemoMode } = useDemoMode();

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>Settings</h2>
      
      <div className="card" style={{ padding: '24px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '20px', color: 'var(--text-primary)' }}>
          Display Options
        </h3>
        
        {/* Demo Mode Toggle */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          padding: '16px',
          backgroundColor: isDemoMode ? 'rgba(199, 112, 240, 0.1)' : 'var(--bg-secondary)',
          borderRadius: '8px',
          border: isDemoMode ? '1px solid #c770f0' : '1px solid var(--border-color)',
        }}>
          <div>
            <div style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>
              Demo Mode
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              When enabled, hides Overview, Approvals, Forms, and Profile pages for cleaner demos
            </div>
          </div>
          <label style={{ 
            position: 'relative', 
            display: 'inline-block', 
            width: '56px', 
            height: '28px',
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={isDemoMode}
              onChange={toggleDemoMode}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: isDemoMode ? '#c770f0' : '#444',
              borderRadius: '28px',
              transition: 'all 0.3s ease',
            }}>
              <span style={{
                position: 'absolute',
                content: '""',
                height: '22px',
                width: '22px',
                left: isDemoMode ? '31px' : '3px',
                bottom: '3px',
                backgroundColor: 'white',
                borderRadius: '50%',
                transition: 'all 0.3s ease',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              }} />
            </span>
          </label>
        </div>

        {isDemoMode && (
          <div style={{ 
            marginTop: '16px', 
            padding: '12px 16px', 
            backgroundColor: 'rgba(199, 112, 240, 0.1)', 
            borderRadius: '8px',
            border: '1px solid rgba(199, 112, 240, 0.3)',
          }}>
            <div style={{ fontSize: '13px', color: '#c770f0', fontWeight: '500' }}>
              🎭 Demo Mode is ON
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Hidden pages: Overview, Approvals, Forms, Profile
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

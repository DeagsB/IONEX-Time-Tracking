import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { usersService } from '../services/supabaseServices';

// Common timezone options
const TIMEZONE_OPTIONS = [
  { value: 'America/Edmonton', label: 'Mountain Time (Calgary)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Vancouver)' },
  { value: 'America/Toronto', label: 'Eastern Time (Toronto)' },
  { value: 'America/Winnipeg', label: 'Central Time (Winnipeg)' },
  { value: 'America/St_Johns', label: 'Newfoundland Time (St. Johns)' },
  { value: 'America/Halifax', label: 'Atlantic Time (Halifax)' },
  { value: 'UTC', label: 'UTC' },
];

const DATE_FORMAT_OPTIONS = [
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
];

const TIME_FORMAT_OPTIONS = [
  { value: '12h', label: '12-hour (3:00 PM)' },
  { value: '24h', label: '24-hour (15:00)' },
];

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  createdAt?: string;
}

interface PasswordData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function Profile() {
  const { user, updateUser, refreshUserProfile } = useAuth();
  
  // Profile form state
  const [profileData, setProfileData] = useState<ProfileData>({
    firstName: '',
    lastName: '',
    email: '',
    timezone: 'America/Edmonton',
    dateFormat: 'MM/DD/YYYY',
    timeFormat: '12h',
  });
  
  // Password form state
  const [passwordData, setPasswordData] = useState<PasswordData>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  
  // UI state
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  
  // Form validation state
  const [profileErrors, setProfileErrors] = useState<Partial<ProfileData>>({});
  const [passwordErrors, setPasswordErrors] = useState<Partial<PasswordData>>({});

  // Load user profile data
  useEffect(() => {
    const loadProfile = async () => {
      if (!user) return;
      
      try {
        const data = await usersService.getUserProfile(user.id);
        setProfileData({
          firstName: data.first_name || user.firstName || '',
          lastName: data.last_name || user.lastName || '',
          email: data.email || user.email || '',
          timezone: data.timezone || 'America/Edmonton',
          dateFormat: data.date_format || 'MM/DD/YYYY',
          timeFormat: data.time_format || '12h',
          createdAt: data.created_at,
        });
      } catch (error) {
        console.error('Error loading profile:', error);
        // Fall back to auth context data
        setProfileData({
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          email: user.email || '',
          timezone: 'America/Edmonton',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
        });
      } finally {
        setIsLoadingProfile(false);
      }
    };
    
    loadProfile();
  }, [user]);

  // Profile update mutation
  const profileMutation = useMutation({
    mutationFn: async (data: ProfileData) => {
      if (!user) throw new Error('Not authenticated');

      // Update profile in users table (email change is hidden for now)
      await usersService.updateProfile(user.id, {
        first_name: data.firstName,
        last_name: data.lastName,
        timezone: data.timezone,
        date_format: data.dateFormat,
        time_format: data.timeFormat,
      });

      return data;
    },
    onSuccess: (data) => {
      updateUser({
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
      });
      setProfileMessage({ type: 'success', text: 'Profile updated successfully!' });
      setTimeout(() => setProfileMessage(null), 5000);
    },
    onError: (error: Error) => {
      setProfileMessage({ type: 'error', text: error.message || 'Failed to update profile' });
    },
  });

  // Password update mutation
  const passwordMutation = useMutation({
    mutationFn: async (data: PasswordData) => {
      if (!user) throw new Error('Not authenticated');
      
      // Verify current password
      const isValid = await usersService.verifyCurrentPassword(user.email, data.currentPassword);
      if (!isValid) {
        throw new Error('Current password is incorrect');
      }
      
      // Update password
      await usersService.updatePassword(data.newPassword);
      return true;
    },
    onSuccess: () => {
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordMessage({ type: 'success', text: 'Password changed successfully!' });
      setTimeout(() => setPasswordMessage(null), 5000);
    },
    onError: (error: Error) => {
      setPasswordMessage({ type: 'error', text: error.message || 'Failed to change password' });
    },
  });

  // Validate profile form
  const validateProfile = (): boolean => {
    const errors: Partial<ProfileData> = {};
    
    if (!profileData.firstName.trim()) {
      errors.firstName = 'First name is required';
    }
    
    if (!profileData.lastName.trim()) {
      errors.lastName = 'Last name is required';
    }
    
    setProfileErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate password form
  const validatePassword = (): boolean => {
    const errors: Partial<PasswordData> = {};
    
    if (!passwordData.currentPassword) {
      errors.currentPassword = 'Current password is required';
    }
    
    if (!passwordData.newPassword) {
      errors.newPassword = 'New password is required';
    } else if (passwordData.newPassword.length < 6) {
      errors.newPassword = 'Password must be at least 6 characters';
    }
    
    if (!passwordData.confirmPassword) {
      errors.confirmPassword = 'Please confirm your new password';
    } else if (passwordData.newPassword !== passwordData.confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }
    
    setPasswordErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle profile form submission
  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setProfileMessage(null);
    
    if (validateProfile()) {
      profileMutation.mutate(profileData);
    }
  };

  // Handle password form submission
  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);
    
    if (validatePassword()) {
      passwordMutation.mutate(passwordData);
    }
  };

  // Format date for display
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    fontSize: '14px',
  };

  const errorInputStyle: React.CSSProperties = {
    ...inputStyle,
    borderColor: '#ff4757',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '6px',
    fontSize: '13px',
    fontWeight: '500',
    color: 'var(--text-secondary)',
  };

  const errorTextStyle: React.CSSProperties = {
    color: '#ff4757',
    fontSize: '12px',
    marginTop: '4px',
  };

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '12px',
    padding: '24px',
    marginBottom: '24px',
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '18px',
    fontWeight: '600',
    marginBottom: '20px',
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  };

  if (isLoadingProfile) {
    return (
      <div>
        <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>Profile Settings</h2>
        <div style={{ ...cardStyle, textAlign: 'center', padding: '48px' }}>
          <div style={{ color: 'var(--text-secondary)' }}>Loading profile...</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>Profile Settings</h2>

      {/* Personal Information Section */}
      <div style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          <span style={{ fontSize: '20px' }}>👤</span>
          Personal Information
        </h3>
        
        <form onSubmit={handleProfileSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '16px' }}>
            <div>
              <label style={labelStyle}>First Name</label>
              <input
                type="text"
                value={profileData.firstName}
                onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                style={profileErrors.firstName ? errorInputStyle : inputStyle}
                placeholder="Enter your first name"
              />
              {profileErrors.firstName && <div style={errorTextStyle}>{profileErrors.firstName}</div>}
            </div>
            
            <div>
              <label style={labelStyle}>Last Name</label>
              <input
                type="text"
                value={profileData.lastName}
                onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                style={profileErrors.lastName ? errorInputStyle : inputStyle}
                placeholder="Enter your last name"
              />
              {profileErrors.lastName && <div style={errorTextStyle}>{profileErrors.lastName}</div>}
            </div>
          </div>
          
          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>Email Address</label>
            <div style={{ ...inputStyle, cursor: 'default', opacity: 0.9 }}>{profileData.email}</div>
          </div>
          
          {profileMessage && (
            <div style={{
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '16px',
              backgroundColor: profileMessage.type === 'success' ? 'rgba(78, 205, 196, 0.1)' : 'rgba(255, 71, 87, 0.1)',
              border: `1px solid ${profileMessage.type === 'success' ? '#4ecdc4' : '#ff4757'}`,
              color: profileMessage.type === 'success' ? '#4ecdc4' : '#ff4757',
            }}>
              {profileMessage.text}
            </div>
          )}
          
          <button
            type="submit"
            disabled={profileMutation.isPending}
            style={{
              padding: '10px 20px',
              backgroundColor: '#4ecdc4',
              color: '#1a1a2e',
              border: 'none',
              borderRadius: '6px',
              fontWeight: '600',
              cursor: profileMutation.isPending ? 'not-allowed' : 'pointer',
              opacity: profileMutation.isPending ? 0.7 : 1,
            }}
          >
            {profileMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Preferences Section */}
      <div style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          <span style={{ fontSize: '20px' }}>⚙️</span>
          Preferences
        </h3>
        
        <form onSubmit={handleProfileSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={labelStyle}>Timezone</label>
              <select
                value={profileData.timezone}
                onChange={(e) => setProfileData({ ...profileData, timezone: e.target.value })}
                style={inputStyle}
              >
                {TIMEZONE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label style={labelStyle}>Date Format</label>
              <select
                value={profileData.dateFormat}
                onChange={(e) => setProfileData({ ...profileData, dateFormat: e.target.value })}
                style={inputStyle}
              >
                {DATE_FORMAT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label style={labelStyle}>Time Format</label>
              <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
                {TIME_FORMAT_OPTIONS.map(opt => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="timeFormat"
                      value={opt.value}
                      checked={profileData.timeFormat === opt.value}
                      onChange={(e) => setProfileData({ ...profileData, timeFormat: e.target.value })}
                      style={{ accentColor: '#4ecdc4' }}
                    />
                    <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          
          <button
            type="submit"
            disabled={profileMutation.isPending}
            style={{
              padding: '10px 20px',
              backgroundColor: '#4ecdc4',
              color: '#1a1a2e',
              border: 'none',
              borderRadius: '6px',
              fontWeight: '600',
              cursor: profileMutation.isPending ? 'not-allowed' : 'pointer',
              opacity: profileMutation.isPending ? 0.7 : 1,
            }}
          >
            {profileMutation.isPending ? 'Saving...' : 'Save Preferences'}
          </button>
        </form>
      </div>

      {/* Password Change Section */}
      <div style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          <span style={{ fontSize: '20px' }}>🔒</span>
          Change Password
        </h3>
        
        <form onSubmit={handlePasswordSubmit}>
          <div style={{ maxWidth: '400px' }}>
            <div style={{ marginBottom: '16px' }}>
              <label style={labelStyle}>Current Password</label>
              <input
                type="password"
                value={passwordData.currentPassword}
                onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                style={passwordErrors.currentPassword ? errorInputStyle : inputStyle}
                placeholder="Enter your current password"
              />
              {passwordErrors.currentPassword && <div style={errorTextStyle}>{passwordErrors.currentPassword}</div>}
            </div>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={labelStyle}>New Password</label>
              <input
                type="password"
                value={passwordData.newPassword}
                onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                style={passwordErrors.newPassword ? errorInputStyle : inputStyle}
                placeholder="Enter your new password"
              />
              {passwordErrors.newPassword && <div style={errorTextStyle}>{passwordErrors.newPassword}</div>}
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Minimum 6 characters
              </div>
            </div>
            
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>Confirm New Password</label>
              <input
                type="password"
                value={passwordData.confirmPassword}
                onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                style={passwordErrors.confirmPassword ? errorInputStyle : inputStyle}
                placeholder="Confirm your new password"
              />
              {passwordErrors.confirmPassword && <div style={errorTextStyle}>{passwordErrors.confirmPassword}</div>}
            </div>
          </div>
          
          {passwordMessage && (
            <div style={{
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '16px',
              maxWidth: '400px',
              backgroundColor: passwordMessage.type === 'success' ? 'rgba(78, 205, 196, 0.1)' : 'rgba(255, 71, 87, 0.1)',
              border: `1px solid ${passwordMessage.type === 'success' ? '#4ecdc4' : '#ff4757'}`,
              color: passwordMessage.type === 'success' ? '#4ecdc4' : '#ff4757',
            }}>
              {passwordMessage.text}
            </div>
          )}
          
          <button
            type="submit"
            disabled={passwordMutation.isPending}
            style={{
              padding: '10px 20px',
              backgroundColor: '#ff6b6b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontWeight: '600',
              cursor: passwordMutation.isPending ? 'not-allowed' : 'pointer',
              opacity: passwordMutation.isPending ? 0.7 : 1,
            }}
          >
            {passwordMutation.isPending ? 'Changing Password...' : 'Change Password'}
          </button>
        </form>
      </div>

      {/* Account Information Section */}
      <div style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          <span style={{ fontSize: '20px' }}>ℹ️</span>
          Account Information
        </h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' }}>
          <div>
            <div style={labelStyle}>User ID</div>
            <div style={{
              padding: '10px 12px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '6px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}>
              {user?.id || 'N/A'}
            </div>
          </div>
          
          <div>
            <div style={labelStyle}>Role</div>
            <div style={{
              padding: '10px 12px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '6px',
              fontSize: '14px',
              color: 'var(--text-primary)',
            }}>
              <span style={{
                padding: '4px 10px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: '600',
                backgroundColor: user?.role === 'ADMIN' ? 'rgba(199, 112, 240, 0.2)' : 'rgba(78, 205, 196, 0.2)',
                color: user?.role === 'ADMIN' ? '#c770f0' : '#4ecdc4',
              }}>
                {user?.role || 'USER'}
              </span>
            </div>
          </div>
          
          <div>
            <div style={labelStyle}>Account Created</div>
            <div style={{
              padding: '10px 12px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '6px',
              fontSize: '14px',
              color: 'var(--text-primary)',
            }}>
              {formatDate(profileData.createdAt)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

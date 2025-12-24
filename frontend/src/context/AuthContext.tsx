import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User as SupabaseUser, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'ADMIN' | 'USER';
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  login: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, firstName: string, lastName: string) => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('🔐 AuthProvider: Initializing auth state...');
    
    // Set a timeout to prevent infinite loading
    const loadingTimeout = setTimeout(() => {
      console.warn('⚠️ AuthProvider: Loading timeout - forcing loading to complete');
      setLoading(false);
    }, 5000); // 5 second timeout

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(loadingTimeout);
      console.log('🔐 AuthProvider: Session retrieved', session ? 'User authenticated' : 'No session');
      setSession(session);
      if (session?.user) {
        fetchUserProfile(session.user);
      } else {
        setLoading(false);
        console.log('🔐 AuthProvider: No user, loading complete');
      }
    }).catch((error) => {
      clearTimeout(loadingTimeout);
      console.error("❌ AuthProvider: Error getting session:", error);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        fetchUserProfile(session.user);
      } else {
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(loadingTimeout);
      subscription.unsubscribe();
    };
  }, []);

  const fetchUserProfile = async (supabaseUser: SupabaseUser) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', supabaseUser.id)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        console.error('Error fetching user profile:', error);
        setLoading(false);
        return;
      }

      if (data) {
        setUser({
          id: data.id,
          email: data.email || supabaseUser.email || '',
          firstName: data.first_name || '',
          lastName: data.last_name || '',
          role: data.role || 'USER',
        });
      } else {
        // User profile doesn't exist yet, create it
        const { data: newUser, error: insertError } = await supabase
          .from('users')
          .insert({
            id: supabaseUser.id,
            email: supabaseUser.email || '',
            first_name: supabaseUser.user_metadata?.first_name || '',
            last_name: supabaseUser.user_metadata?.last_name || '',
            role: 'USER',
          })
          .select()
          .single();

        if (!insertError && newUser) {
          setUser({
            id: newUser.id,
            email: newUser.email || '',
            firstName: newUser.first_name || '',
            lastName: newUser.last_name || '',
            role: newUser.role || 'USER',
          });
        }
      }
      setLoading(false);
    } catch (error) {
      console.error('Error in fetchUserProfile:', error);
      setLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    if (data.session) {
      setSession(data.session);
      if (data.user) {
        await fetchUserProfile(data.user);
      }
    }
  };

  const signUp = async (email: string, password: string, firstName: string, lastName: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    });

    if (error) throw error;
    // Note: Supabase requires email confirmation by default
    // User profile will be created automatically via trigger
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        login,
        signUp,
        logout,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

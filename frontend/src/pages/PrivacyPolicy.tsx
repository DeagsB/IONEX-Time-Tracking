import { Link } from 'react-router-dom';

const APP_NAME = 'IONEX Time Tracking';
const APP_URL = 'https://ionex-timer.vercel.app';

export default function PrivacyPolicy() {
  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        padding: '24px',
        maxWidth: '720px',
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
        lineHeight: 1.6,
      }}
    >
      <div style={{ marginBottom: '24px' }}>
        <Link
          to="/login"
          style={{ color: 'var(--primary-color)', textDecoration: 'none', fontSize: '14px' }}
        >
          ← Back to {APP_NAME}
        </Link>
      </div>

      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>
        Privacy Policy
      </h1>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
        Last updated: February 2025
      </p>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>1. Introduction</h2>
        <p>
          This Privacy Policy describes how {APP_NAME} (“we,” “our,” or “the Service”) at {APP_URL} collects,
          uses, and protects information when you use the Service. By using the Service, you agree to the
          practices described here.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>2. Information We Collect</h2>
        <p>
          We collect information you provide directly, such as:
        </p>
        <ul style={{ marginLeft: '20px', marginTop: '8px' }}>
          <li>Account information (email, name, password hash)</li>
          <li>Time entries, projects, customers, and related business data</li>
          <li>Service tickets, invoices, and documents you upload</li>
          <li>Integration data (e.g., QuickBooks) when you connect third-party services</li>
        </ul>
        <p style={{ marginTop: '8px' }}>
          We also collect technical information such as IP address and browser type in connection with
          providing and securing the Service.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>3. How We Use Information</h2>
        <p>
          We use the information to operate, maintain, and improve the Service; to authenticate users; to
          provide support; to send important service-related communications; and to comply with legal
          obligations. We do not sell your personal information to third parties.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>4. Data Storage and Security</h2>
        <p>
          Data is stored using Supabase and related infrastructure. We use industry-standard measures to
          protect your data. You are responsible for keeping your login credentials secure.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>5. Third-Party Services</h2>
        <p>
          The Service may integrate with third-party services (e.g., QuickBooks Online). When you connect
          such services, their respective privacy policies also apply to data shared with them. We only share
          data with third parties as necessary to provide the integration and as described in this policy.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>6. Data Retention</h2>
        <p>
          We retain your data for as long as your account is active or as needed to provide the Service and
          fulfill the purposes described in this policy. You may request deletion of your account and
          associated data subject to applicable law and our retention obligations.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>7. Your Rights</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, or port your personal
          data, or to object to or restrict certain processing. To exercise these rights, contact the
          administrator of your account or the party that operates the Service.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>8. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will post the updated policy on this page
          and update the “Last updated” date. Continued use of the Service after changes constitutes
          acceptance of the updated policy.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>9. Contact</h2>
        <p>
          For privacy-related questions or requests, please contact the administrator of your {APP_NAME}
          account or the party that provided you access to the Service.
        </p>
      </section>

      <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
        <Link
          to="/login"
          style={{ color: 'var(--primary-color)', textDecoration: 'none', fontSize: '14px' }}
        >
          ← Back to {APP_NAME}
        </Link>
      </div>
    </div>
  );
}

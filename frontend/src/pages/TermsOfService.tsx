import { Link } from 'react-router-dom';

const APP_NAME = 'IONEX Time Tracking';
const APP_URL = 'https://ionex-timer.vercel.app';

export default function TermsOfService() {
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
        End User Agreement (Terms of Service)
      </h1>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
        Last updated: February 2025
      </p>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>1. Agreement</h2>
        <p>
          By accessing or using {APP_NAME} (“Service”) at {APP_URL}, you agree to be bound by this End User Agreement.
          If you do not agree, do not use the Service.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>2. Use of the Service</h2>
        <p>
          The Service provides time tracking, project and customer management, service tickets, and invoicing tools.
          You must use the Service only for lawful purposes and in accordance with these terms. You are responsible
          for maintaining the confidentiality of your account and for all activity under your account.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>3. Account and Data</h2>
        <p>
          You must provide accurate information when registering. You are responsible for the data you enter and
          for ensuring that your use of the Service (including integration with third-party services such as
          QuickBooks) complies with applicable laws and third-party terms.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>4. Acceptable Use</h2>
        <p>
          You may not use the Service to violate any law, infringe others’ rights, transmit harmful or offensive
          content, or attempt to gain unauthorized access to the Service or related systems. We may suspend or
          terminate access for violation of these terms.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>5. Intellectual Property</h2>
        <p>
          The Service and its content (excluding your data) are owned by the operator of {APP_NAME} and are
          protected by intellectual property laws. You do not acquire any ownership rights by using the Service.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>6. Disclaimers</h2>
        <p>
          The Service is provided “as is.” We do not warrant that the Service will be uninterrupted, error-free,
          or fit for a particular purpose. To the extent permitted by law, we disclaim all warranties, express or
          implied.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>7. Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, we are not liable for any indirect, incidental, special,
          consequential, or punitive damages, or for loss of data or profits, arising from your use of the Service.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>8. Changes</h2>
        <p>
          We may update this agreement from time to time. Continued use of the Service after changes constitutes
          acceptance. We encourage you to review this page periodically.
        </p>
      </section>

      <section style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>9. Contact</h2>
        <p>
          For questions about these terms, please contact the administrator of your {APP_NAME} account or the
          party that provided you access to the Service.
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

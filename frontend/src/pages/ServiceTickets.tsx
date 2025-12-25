import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { serviceTicketsService, customersService, employeesService } from '../services/supabaseServices';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket } from '../utils/serviceTickets';
import { downloadPdfServiceTicket } from '../utils/pdfServiceTicket';

export default function ServiceTickets() {
  const { user } = useAuth();
  
  // Filters state
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30); // Default to last 30 days
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [approvedOnly, setApprovedOnly] = useState(false);
  
  // Ticket preview state
  const [selectedTicket, setSelectedTicket] = useState<ServiceTicket | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Handler for exporting ticket as PDF
  const handleExportTicket = async (ticket: ServiceTicket) => {
    setIsExporting(true);
    try {
      await downloadPdfServiceTicket(ticket);
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export service ticket PDF. Check console for details.');
    } finally {
      setIsExporting(false);
    }
  };

  // Fetch billable entries
  const { data: billableEntries, isLoading: isLoadingEntries, error: entriesError } = useQuery({
    queryKey: ['billableEntries', startDate, endDate, selectedCustomerId, selectedUserId, approvedOnly],
    queryFn: () => serviceTicketsService.getBillableEntries({
      startDate,
      endDate,
      customerId: selectedCustomerId || undefined,
      userId: selectedUserId || undefined,
      approvedOnly,
    }),
  });

  // Fetch customers for filter
  const { data: customers } = useQuery({
    queryKey: ['customers'],
    queryFn: () => customersService.getAll(),
  });

  // Fetch employees for filter
  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: () => employeesService.getAll(),
  });

  // Group entries into tickets
  const tickets = useMemo(() => {
    if (!billableEntries) return [];
    return groupEntriesIntoTickets(billableEntries);
  }, [billableEntries]);

  // Filter by customer on frontend (optional, for additional client-side filtering)
  const filteredTickets = useMemo(() => {
    let result = tickets;
    if (selectedCustomerId) {
      result = result.filter(t => t.customerId === selectedCustomerId);
    }
    return result;
  }, [tickets, selectedCustomerId]);

  if (user?.role !== 'ADMIN') {
    return (
      <div>
        <h2>Service Tickets</h2>
        <div className="card">
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
          Service Tickets
        </h2>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '24px', padding: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div>
            <label className="label">Start Date</label>
            <input
              type="date"
              className="input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div>
            <label className="label">End Date</label>
            <input
              type="date"
              className="input"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            />
          </div>
          <div>
            <label className="label">Customer</label>
            <select
              className="input"
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">All Customers</option>
              {customers?.map((customer: any) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Employee</label>
            <select
              className="input"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">All Employees</option>
              {employees?.map((employee: any) => (
                <option key={employee.user_id} value={employee.user_id}>
                  {employee.user?.first_name} {employee.user?.last_name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={approvedOnly}
                onChange={(e) => setApprovedOnly(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#c770f0' }}
              />
              <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>Approved Only</span>
            </label>
          </div>
        </div>
      </div>

      {/* Tickets List */}
      {entriesError ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: '#ef5350', marginBottom: '10px', fontWeight: '600' }}>
            Error loading service tickets
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            {entriesError instanceof Error ? entriesError.message : 'Unknown error occurred'}
          </p>
        </div>
      ) : isLoadingEntries ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading service tickets...</p>
        </div>
      ) : filteredTickets.length === 0 ? (
        <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            No billable time entries found for the selected filters.
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Ticket ID
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Date
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Customer
                </th>
                <th style={{ padding: '16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Tech
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Total Hours
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  RT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  OT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  TT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FT
                </th>
                <th style={{ padding: '16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  FOT
                </th>
                <th style={{ padding: '16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '13px' }}>
                    {generateTicketDisplayId(ticket)}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {new Date(ticket.date).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontWeight: '500' }}>
                    {ticket.customerName}
                  </td>
                  <td style={{ padding: '16px', color: 'var(--text-primary)' }}>
                    {ticket.userName}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: '600' }}>
                    {ticket.totalHours.toFixed(2)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Shop Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Shop Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Travel Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Time'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {ticket.hoursByRateType['Field Overtime'].toFixed(1)}
                  </td>
                  <td style={{ padding: '16px', textAlign: 'center' }}>
                    <button
                      className="button button-secondary"
                      onClick={() => setSelectedTicket(ticket)}
                      style={{
                        padding: '6px 16px',
                        fontSize: '13px',
                      }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ticket Preview Modal */}
      {selectedTicket && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => setSelectedTicket(null)}
        >
          <div
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '12px',
              maxWidth: '900px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ticket Header */}
            <div
              style={{
                padding: '24px',
                borderBottom: '2px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px 0' }}>
                  SERVICE TICKET
                </h2>
                <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>
                  Ticket: {generateTicketDisplayId(selectedTicket)}
                </p>
              </div>
              <button
                onClick={() => setSelectedTicket(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px 8px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '24px' }}>
              {/* Customer & Service Info Section */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
                {/* Customer Info */}
                <div
                  style={{
                    backgroundColor: '#FFF9E6',
                    border: '2px solid #FFE066',
                    borderRadius: '8px',
                    padding: '16px',
                  }}
                >
                  <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#333', marginBottom: '12px' }}>
                    Customer Information
                  </h3>
                  <div style={{ color: '#333', fontSize: '14px', lineHeight: '1.6' }}>
                    <p style={{ margin: '0 0 4px 0', fontWeight: '600' }}>
                      {selectedTicket.customerInfo.name}
                    </p>
                    {selectedTicket.customerInfo.address && (
                      <p style={{ margin: '0 0 4px 0' }}>{selectedTicket.customerInfo.address}</p>
                    )}
                    {selectedTicket.customerInfo.city && (
                      <p style={{ margin: '0 0 4px 0' }}>
                        {selectedTicket.customerInfo.city}
                        {selectedTicket.customerInfo.state && `, ${selectedTicket.customerInfo.state}`}
                        {selectedTicket.customerInfo.zip_code && ` ${selectedTicket.customerInfo.zip_code}`}
                      </p>
                    )}
                    {selectedTicket.customerInfo.phone && (
                      <p style={{ margin: '4px 0 0 0' }}>
                        <strong>Phone:</strong> {selectedTicket.customerInfo.phone}
                      </p>
                    )}
                    {selectedTicket.customerInfo.email && (
                      <p style={{ margin: '4px 0 0 0' }}>
                        <strong>Email:</strong> {selectedTicket.customerInfo.email}
                      </p>
                    )}
                  </div>
                </div>

                {/* Service Info */}
                <div
                  style={{
                    backgroundColor: '#FFE8CC',
                    border: '2px solid #FFB366',
                    borderRadius: '8px',
                    padding: '16px',
                  }}
                >
                  <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#333', marginBottom: '12px' }}>
                    Service Information
                  </h3>
                  <div style={{ color: '#333', fontSize: '14px', lineHeight: '1.6' }}>
                    <p style={{ margin: '0 0 8px 0' }}>
                      <strong>Tech:</strong> {selectedTicket.userName}
                    </p>
                    <p style={{ margin: '0 0 8px 0' }}>
                      <strong>Date:</strong> {formatTicketDate(selectedTicket.date)}
                    </p>
                    <p style={{ margin: '0 0 0 0' }}>
                      <strong>Total Hours:</strong> {selectedTicket.totalHours.toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Service Description Section */}
              <div
                style={{
                  backgroundColor: '#E8F5E9',
                  border: '2px solid #81C784',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '24px',
                }}
              >
                <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#333', marginBottom: '12px' }}>
                  Service Description
                </h3>
                <div style={{ color: '#333', fontSize: '14px' }}>
                  {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => {
                    if (hours === 0) return null;
                    const entriesForType = selectedTicket.entries.filter(
                      (e) => (e.rate_type || 'Shop Time') === rateType
                    );
                    return (
                      <div key={rateType} style={{ marginBottom: '16px' }}>
                        <h4 style={{ fontSize: '13px', fontWeight: '600', color: '#2E7D32', marginBottom: '8px' }}>
                          {rateType} ({hours.toFixed(2)} hrs)
                        </h4>
                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                          {entriesForType.map((entry) => (
                            <li key={entry.id} style={{ marginBottom: '4px', lineHeight: '1.5' }}>
                              {entry.description || 'No description'}
                              {entry.start_time && entry.end_time && (
                                <span style={{ color: '#666', fontSize: '12px', marginLeft: '8px' }}>
                                  ({new Date(entry.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - 
                                  {new Date(entry.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})
                                </span>
                              )}
                              <span style={{ fontWeight: '600', marginLeft: '8px' }}>
                                {entry.hours.toFixed(2)} hrs
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Totals Section */}
              <div
                style={{
                  backgroundColor: '#FFEBEE',
                  border: '2px solid #EF5350',
                  borderRadius: '8px',
                  padding: '16px',
                }}
              >
                <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#333', marginBottom: '12px' }}>
                  Hours Summary
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                  {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => (
                    <div key={rateType} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', color: '#333', fontWeight: '500' }}>{rateType}:</span>
                      <span style={{ fontSize: '14px', color: '#333', fontWeight: '700' }}>{hours.toFixed(2)}</span>
                    </div>
                  ))}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gridColumn: 'span 3',
                      paddingTop: '12px',
                      borderTop: '2px solid #EF5350',
                      marginTop: '8px',
                    }}
                  >
                    <span style={{ fontSize: '15px', color: '#333', fontWeight: '700' }}>TOTAL HOURS:</span>
                    <span style={{ fontSize: '18px', color: '#C62828', fontWeight: '700' }}>
                      {selectedTicket.totalHours.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button
                  className="button button-secondary"
                  onClick={() => setSelectedTicket(null)}
                  style={{ padding: '10px 24px' }}
                  disabled={isExporting}
                >
                  Close
                </button>
                <button
                  className="button button-primary"
                  onClick={() => handleExportTicket(selectedTicket)}
                  style={{ padding: '10px 24px' }}
                  disabled={isExporting}
                >
                  {isExporting ? 'Generating PDF...' : 'Export PDF'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


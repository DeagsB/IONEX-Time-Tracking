import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { serviceTicketsService, customersService, employeesService } from '../services/supabaseServices';
import { groupEntriesIntoTickets, formatTicketDate, generateTicketDisplayId, ServiceTicket } from '../utils/serviceTickets';
import { downloadExcelServiceTicket } from '../utils/serviceTicketXlsx';
import { downloadPdfServiceTicket } from '../utils/pdfServiceTicket';
import { supabase } from '../lib/supabaseClient';

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
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  
  // Editable ticket fields state
  const [editableTicket, setEditableTicket] = useState<{
    customerName: string;
    address: string;
    cityState: string;
    zipCode: string;
    phone: string;
    email: string;
    contactName: string;
    serviceLocation: string;
    locationCode: string;
    poNumber: string;
    approverName: string;
    techName: string;
    projectNumber: string;
    date: string;
  } | null>(null);
  
  // Generated ticket number for display
  const [displayTicketNumber, setDisplayTicketNumber] = useState<string>('');

  // Handler for exporting ticket as PDF
  const handleExportPdf = async (ticket: ServiceTicket) => {
    setIsExportingPdf(true);
    try {
      // Use the ticket number that was already set (either from DB or newly generated)
      const ticketNumber = ticket.ticketNumber || displayTicketNumber;
      const ticketWithNumber = { ...ticket, ticketNumber };
      
      await downloadPdfServiceTicket(ticketWithNumber);
    } catch (error) {
      console.error('PDF export error:', error);
      alert('Failed to export service ticket PDF. Check console for details.');
    } finally {
      setIsExportingPdf(false);
    }
  };

  // Handler for exporting ticket as Excel
  const handleExportExcel = async (ticket: ServiceTicket) => {
    setIsExportingExcel(true);
    try {
      // Use the ticket number that was already set (either from DB or newly generated)
      const ticketNumber = ticket.ticketNumber || displayTicketNumber;
      
      // Create a copy of the ticket with the ticket number
      const ticketWithNumber = { ...ticket, ticketNumber };
      
      await downloadExcelServiceTicket(ticketWithNumber);
      
      // Only create a new record if this ticket doesn't already have one
      // Check if a record already exists for this date/user/customer combo
      const existingRecord = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      if (!existingRecord) {
        // Calculate totals for recording
        const rtRate = 130, ttRate = 130, ftRate = 140, otRate = 195;
        const rtAmount = ticket.hoursByRateType['Shop Time'] * rtRate;
        const ttAmount = ticket.hoursByRateType['Travel Time'] * ttRate;
        const ftAmount = ticket.hoursByRateType['Field Time'] * ftRate;
        const otAmount = (ticket.hoursByRateType['Shop Overtime'] + ticket.hoursByRateType['Field Overtime']) * otRate;
        const totalAmount = rtAmount + ttAmount + ftAmount + otAmount;
        
        // Save the ticket record to the database
        const year = new Date().getFullYear() % 100;
        const sequenceMatch = ticketNumber.match(/\d{3}$/);
        const sequenceNumber = sequenceMatch ? parseInt(sequenceMatch[0]) : 1;
        
        await serviceTicketsService.createTicketRecord({
          ticketNumber,
          employeeInitials: ticket.userInitials,
          year,
          sequenceNumber,
          date: ticket.date,
          customerId: ticket.customerId !== 'unassigned' ? ticket.customerId : undefined,
          userId: ticket.userId,
          projectId: ticket.projectId,
          totalHours: ticket.totalHours,
          totalAmount,
        });
      }
    } catch (error) {
      alert('Failed to export service ticket Excel.');
    } finally {
      setIsExportingExcel(false);
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

  // Fetch existing ticket numbers for display
  const { data: existingTickets } = useQuery({
    queryKey: ['existingServiceTickets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_tickets')
        .select('id, ticket_number, date, user_id, customer_id');
      if (error) throw error;
      return data;
    },
  });

  // Match tickets with existing ticket numbers or generate preview
  const ticketsWithNumbers = useMemo(() => {
    return tickets.map(ticket => {
      // Try to find an existing ticket number for this specific ticket
      const existing = existingTickets?.find(
        et => et.date === ticket.date && 
              et.user_id === ticket.userId && 
              (et.customer_id === ticket.customerId || (!et.customer_id && ticket.customerId === 'unassigned'))
      );
      
      return {
        ...ticket,
        displayTicketNumber: existing?.ticket_number || `${ticket.userInitials}_${new Date(ticket.date).getFullYear() % 100}XXX`
      };
    });
  }, [tickets, existingTickets]);

  // Filter by customer on frontend (optional, for additional client-side filtering)
  const filteredTickets = useMemo(() => {
    let result = ticketsWithNumbers;
    if (selectedCustomerId) {
      result = result.filter(t => t.customerId === selectedCustomerId);
    }
    return result;
  }, [ticketsWithNumbers, selectedCustomerId]);

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
              {filteredTickets.map((ticket) => {
                const handleRowClick = () => {
                  setSelectedTicket(ticket);
                  setEditableTicket({
                    customerName: ticket.customerInfo.name || '',
                    address: ticket.customerInfo.address || '',
                    cityState: ticket.customerInfo.city && ticket.customerInfo.state 
                      ? `${ticket.customerInfo.city}, ${ticket.customerInfo.state}`
                      : ticket.customerInfo.city || ticket.customerInfo.state || '',
                    zipCode: ticket.customerInfo.zip_code || '',
                    phone: ticket.customerInfo.phone || '',
                    email: ticket.customerInfo.email || '',
                    contactName: ticket.userName || '',
                    serviceLocation: ticket.customerInfo.service_location || ticket.customerInfo.address || '',
                    locationCode: ticket.customerInfo.location_code || '',
                    poNumber: ticket.customerInfo.po_number || '',
                    approverName: ticket.customerInfo.approver_name || '',
                    techName: ticket.userName || '',
                    projectNumber: ticket.projectNumber || '',
                    date: ticket.date || '',
                  });
                  
                  // Use existing ticket number if already exported, otherwise generate a new one
                  if (ticket.displayTicketNumber && !ticket.displayTicketNumber.includes('XXX')) {
                    // This ticket was already exported - use the existing number
                    setDisplayTicketNumber(ticket.displayTicketNumber);
                  } else {
                    // Generate a new ticket number for first-time export
                    serviceTicketsService.getNextTicketNumber(ticket.userInitials)
                      .then(num => setDisplayTicketNumber(num))
                      .catch(() => setDisplayTicketNumber(`${ticket.userInitials}_${new Date().getFullYear() % 100}XXX`));
                  }
                };

                return (
                <tr
                  key={ticket.id}
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    transition: 'background-color 0.2s',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={handleRowClick}
                >
                  <td style={{ padding: '16px', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '13px' }}>
                    {ticket.displayTicketNumber}
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
                  <td style={{ padding: '16px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className="button"
                      onClick={() => {
                        // TODO: Implement mark as invoiced functionality
                        alert('Mark as invoiced functionality coming soon!');
                      }}
                      style={{
                        padding: '6px 16px',
                        fontSize: '13px',
                        backgroundColor: '#4caf50',
                        color: 'white',
                        border: 'none',
                      }}
                    >
                      Mark as Invoiced
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Ticket Preview Modal */}
      {selectedTicket && editableTicket && (
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
          onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
        >
          <div
            style={{
              backgroundColor: '#1a1a2e',
              borderRadius: '12px',
              maxWidth: '900px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ticket Header */}
            <div
              style={{
                padding: '24px',
                borderBottom: '1px solid rgba(255,255,255,0.1)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: '700', color: '#fff', margin: '0 0 8px 0' }}>
                  SERVICE TICKET
                </h2>
                <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                  Ticket: {displayTicketNumber || 'Loading...'}
                </p>
              </div>
              <button
                onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  color: 'rgba(255,255,255,0.6)',
                  cursor: 'pointer',
                  padding: '4px 8px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '24px' }}>
              {/* Editable input style */}
              {(() => {
                const inputStyle: React.CSSProperties = {
                  width: '100%',
                  padding: '8px 12px',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px',
                  outline: 'none',
                };
                const labelStyle: React.CSSProperties = {
                  display: 'block',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                };
                const sectionStyle: React.CSSProperties = {
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '16px',
                };
                const sectionTitleStyle: React.CSSProperties = {
                  fontSize: '12px',
                  fontWeight: '700',
                  textTransform: 'uppercase',
                  color: '#c770f0',
                  marginBottom: '16px',
                  letterSpacing: '1px',
                };

                return (
                  <>
                    {/* Customer & Service Info Section */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                      {/* Customer Info */}
                      <div style={sectionStyle}>
                        <h3 style={sectionTitleStyle}>Customer Information</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div>
                            <label style={labelStyle}>Customer Name</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.customerName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, customerName: e.target.value })}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Address</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.address}
                              onChange={(e) => setEditableTicket({ ...editableTicket, address: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>City, Province</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.cityState}
                                onChange={(e) => setEditableTicket({ ...editableTicket, cityState: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Postal Code</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.zipCode}
                                onChange={(e) => setEditableTicket({ ...editableTicket, zipCode: e.target.value })}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Phone</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.phone}
                                onChange={(e) => setEditableTicket({ ...editableTicket, phone: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Email</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.email}
                                onChange={(e) => setEditableTicket({ ...editableTicket, email: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Contact Name</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.contactName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, contactName: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Service Info */}
                      <div style={sectionStyle}>
                        <h3 style={sectionTitleStyle}>Service Information</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div>
                            <label style={labelStyle}>Technician</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.techName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, techName: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Project Number</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.projectNumber}
                                onChange={(e) => setEditableTicket({ ...editableTicket, projectNumber: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Date</label>
                              <input
                                type="date"
                                style={inputStyle}
                                value={editableTicket.date}
                                onChange={(e) => setEditableTicket({ ...editableTicket, date: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Service Location</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.serviceLocation}
                              onChange={(e) => setEditableTicket({ ...editableTicket, serviceLocation: e.target.value })}
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={labelStyle}>Location Code</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.locationCode}
                                onChange={(e) => setEditableTicket({ ...editableTicket, locationCode: e.target.value })}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>PO Number</label>
                              <input
                                style={inputStyle}
                                value={editableTicket.poNumber}
                                onChange={(e) => setEditableTicket({ ...editableTicket, poNumber: e.target.value })}
                              />
                            </div>
                          </div>
                          <div>
                            <label style={labelStyle}>Approver</label>
                            <input
                              style={inputStyle}
                              value={editableTicket.approverName}
                              onChange={(e) => setEditableTicket({ ...editableTicket, approverName: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Service Description Section */}
                    <div style={sectionStyle}>
                      <h3 style={sectionTitleStyle}>Service Description</h3>
                      <div style={{ color: '#fff', fontSize: '14px' }}>
                        {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => {
                          if (hours === 0) return null;
                          const entriesForType = selectedTicket.entries.filter(
                            (e) => (e.rate_type || 'Shop Time') === rateType
                          );
                          return (
                            <div key={rateType} style={{ marginBottom: '16px' }}>
                              <h4 style={{ fontSize: '13px', fontWeight: '600', color: '#c770f0', marginBottom: '8px' }}>
                                {rateType} ({hours.toFixed(2)} hrs)
                              </h4>
                              <ul style={{ margin: 0, paddingLeft: '20px', color: 'rgba(255,255,255,0.8)' }}>
                                {entriesForType.map((entry) => (
                                  <li key={entry.id} style={{ marginBottom: '4px', lineHeight: '1.5' }}>
                                    {entry.description || 'No description'}
                                    {entry.start_time && entry.end_time && (
                                      <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px', marginLeft: '8px' }}>
                                        ({new Date(entry.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - 
                                        {new Date(entry.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})
                                      </span>
                                    )}
                                    <span style={{ fontWeight: '600', marginLeft: '8px', color: '#fff' }}>
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

                    {/* Hours Summary Section */}
                    <div style={sectionStyle}>
                      <h3 style={sectionTitleStyle}>Hours Summary</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                        {Object.entries(selectedTicket.hoursByRateType).map(([rateType, hours]) => (
                          <div key={rateType} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', fontWeight: '500' }}>{rateType}:</span>
                            <span style={{ fontSize: '14px', color: '#fff', fontWeight: '700' }}>{hours.toFixed(2)}</span>
                          </div>
                        ))}
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gridColumn: 'span 3',
                            paddingTop: '12px',
                            borderTop: '1px solid rgba(255,255,255,0.2)',
                            marginTop: '8px',
                          }}
                        >
                          <span style={{ fontSize: '15px', color: '#fff', fontWeight: '700' }}>TOTAL HOURS:</span>
                          <span style={{ fontSize: '18px', color: '#c770f0', fontWeight: '700' }}>
                            {selectedTicket.totalHours.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}

              {/* Action Buttons */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button
                  className="button button-secondary"
                  onClick={() => { setSelectedTicket(null); setEditableTicket(null); }}
                  style={{ padding: '10px 24px' }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  Close
                </button>
                <button
                  className="button button-primary"
                  onClick={() => {
                    // Create a modified ticket with the editable values
                    const modifiedTicket: ServiceTicket = {
                      ...selectedTicket,
                      userName: editableTicket.techName,
                      projectNumber: editableTicket.projectNumber,
                      date: editableTicket.date,
                      ticketNumber: displayTicketNumber,
                      customerInfo: {
                        ...selectedTicket.customerInfo,
                        name: editableTicket.customerName,
                        address: editableTicket.address,
                        city: editableTicket.cityState.split(',')[0]?.trim() || '',
                        state: editableTicket.cityState.split(',')[1]?.trim() || '',
                        zip_code: editableTicket.zipCode,
                        phone: editableTicket.phone,
                        email: editableTicket.email,
                        service_location: editableTicket.serviceLocation,
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                    };
                    handleExportExcel(modifiedTicket);
                  }}
                  style={{ 
                    padding: '10px 24px',
                    backgroundColor: '#4caf50',
                    borderColor: '#4caf50',
                  }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  {isExportingExcel ? 'Generating Excel...' : 'Export Excel'}
                </button>
                <button
                  className="button button-primary"
                  onClick={() => {
                    // Create a modified ticket with the editable values
                    const modifiedTicket: ServiceTicket = {
                      ...selectedTicket,
                      userName: editableTicket.techName,
                      projectNumber: editableTicket.projectNumber,
                      date: editableTicket.date,
                      ticketNumber: displayTicketNumber,
                      customerInfo: {
                        ...selectedTicket.customerInfo,
                        name: editableTicket.customerName,
                        address: editableTicket.address,
                        city: editableTicket.cityState.split(',')[0]?.trim() || '',
                        state: editableTicket.cityState.split(',')[1]?.trim() || '',
                        zip_code: editableTicket.zipCode,
                        phone: editableTicket.phone,
                        email: editableTicket.email,
                        service_location: editableTicket.serviceLocation,
                        location_code: editableTicket.locationCode,
                        po_number: editableTicket.poNumber,
                        approver_name: editableTicket.approverName,
                      },
                    };
                    handleExportPdf(modifiedTicket);
                  }}
                  style={{ padding: '10px 24px' }}
                  disabled={isExportingExcel || isExportingPdf}
                >
                  {isExportingPdf ? 'Generating PDF...' : 'Export PDF'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


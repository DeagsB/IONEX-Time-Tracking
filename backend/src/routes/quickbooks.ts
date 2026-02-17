/**
 * QuickBooks Online API Routes
 * Handles OAuth callbacks and invoice operations
 */

import { Router, Request, Response } from 'express';
import { quickbooksService } from '../services/quickbooksService';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

/**
 * GET /api/quickbooks/ping
 * Public route to verify QuickBooks API is deployed (no auth). Use in browser or health checks.
 */
router.get('/ping', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'quickbooks' });
});

/**
 * GET /api/quickbooks/auth-url
 * Generate OAuth2 authorization URL for QuickBooks connection
 */
router.get('/auth-url', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    // Generate a random state for CSRF protection
    const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
    
    const authUrl = quickbooksService.getAuthorizationUrl(state);
    
    res.json({ 
      success: true, 
      authUrl,
      state 
    });
  } catch (error: any) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/quickbooks/callback
 * OAuth2 callback handler - exchanges code for tokens
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, realmId, state, error } = req.query;
    
    if (error) {
      // User denied access or error occurred
      return res.redirect(`${process.env.FRONTEND_URL}/profile?qbo=error&message=${encodeURIComponent(error as string)}`);
    }
    
    if (!code || !realmId) {
      return res.redirect(`${process.env.FRONTEND_URL}/profile?qbo=error&message=Missing+required+parameters`);
    }
    
    // Exchange code for tokens
    await quickbooksService.exchangeCodeForTokens(code as string, realmId as string);
    
    // Redirect back to frontend with success
    res.redirect(`${process.env.FRONTEND_URL}/profile?qbo=success`);
  } catch (error: any) {
    console.error('Error in QBO callback:', error);
    res.redirect(`${process.env.FRONTEND_URL}/profile?qbo=error&message=${encodeURIComponent(error.message)}`);
  }
});

/**
 * GET /api/quickbooks/status
 * Check if QuickBooks is connected
 */
router.get('/status', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const isConnected = await quickbooksService.isConnected();
    
    res.json({ 
      success: true, 
      connected: isConnected 
    });
  } catch (error: any) {
    console.error('Error checking QBO status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/quickbooks/disconnect
 * Disconnect QuickBooks integration
 */
router.post('/disconnect', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    await quickbooksService.disconnect();
    
    res.json({ 
      success: true, 
      message: 'QuickBooks disconnected successfully' 
    });
  } catch (error: any) {
    console.error('Error disconnecting QBO:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/quickbooks/invoice
 * Create an invoice in QuickBooks
 */
router.post('/invoice', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const { customerName, customerEmail, lineItems, ticketNumber, date, dueDate, memo } = req.body;
    
    if (!customerName || !lineItems || !ticketNumber || !date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customerName, lineItems, ticketNumber, date'
      });
    }
    
    const result = await quickbooksService.createInvoice({
      customerName,
      customerEmail,
      lineItems,
      ticketNumber,
      date,
      dueDate,
      memo,
    });
    
    res.json({ 
      success: true, 
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber
    });
  } catch (error: any) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/quickbooks/invoice/from-group
 * Create an invoice from grouped service tickets (CNRL format)
 * Body: { customerName, customerEmail?, customerPo?, reference?, poAfeLineItems: [{ poAfe, tickets, totalAmount }], date, docNumber? }
 */
router.post('/invoice/from-group', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const { customerName, customerEmail, customerPo, reference, poAfeLineItems, date, docNumber } = req.body;

    if (!customerName || !poAfeLineItems || !Array.isArray(poAfeLineItems) || !date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customerName, poAfeLineItems (array), date',
      });
    }

    const result = await quickbooksService.createInvoiceFromGroup({
      customerName,
      customerEmail,
      customerPo,
      reference,
      poAfeLineItems,
      date,
      docNumber,
    });

    res.json({
      success: true,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
    });
  } catch (error: any) {
    console.error('Error creating invoice from group:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/quickbooks/invoice/:invoiceId/attach
 * Attach a PDF to an invoice
 */
router.post('/invoice/:invoiceId/attach', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    const { pdfBase64, fileName } = req.body;
    
    if (!pdfBase64 || !fileName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: pdfBase64, fileName'
      });
    }
    
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    
    await quickbooksService.attachFileToInvoice(invoiceId, pdfBuffer, fileName);
    
    res.json({ 
      success: true, 
      message: 'PDF attached successfully' 
    });
  } catch (error: any) {
    console.error('Error attaching PDF:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/quickbooks/invoice/:invoiceId
 * Get invoice details
 */
router.get('/invoice/:invoiceId', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const invoice = await quickbooksService.getInvoice(invoiceId);
    
    res.json({ 
      success: true, 
      invoice 
    });
  } catch (error: any) {
    console.error('Error getting invoice:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

export default router;

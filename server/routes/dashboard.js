import express from 'express';
import db from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get dashboard summary
router.get('/summary', authenticateToken, (req, res) => {
  try {
    // Get total dues (jcc_entries + approved vouchers)
    const jccDuesResult = db.prepare(`
      SELECT COALESCE(SUM(approved_amount), 0) as total
      FROM jcc_entries
    `).get();

    const voucherDuesResult = db.prepare(`
      SELECT COALESCE(SUM(CAST(basic_amount AS REAL)), 0) as total
      FROM voucher_requests
      WHERE status = 'approved'
    `).get();

    const totalDues = jccDuesResult.total + voucherDuesResult.total;

    // Get pending invoices count (invoices + vouchers)
    const pendingInvoicesCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status = 'pending'
    `).get();

    const pendingVouchersCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM voucher_requests
      WHERE status IN ('pending', 'pending_approval_1', 'pending_approval_2')
    `).get();

    // Get approved count
    const approvedInvoicesCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM invoices
      WHERE status = 'approved'
    `).get();

    const approvedVouchersCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM voucher_requests
      WHERE status = 'approved'
    `).get();

    // Get vendor dues breakdown (combine invoices and vouchers)
    const invoiceDues = db.prepare(`
      SELECT 
        i.vendor_name,
        SUM(j.approved_amount) as total_dues,
        i.status,
        MAX(j.created_at) as last_updated,
        NULL as approver1_name,
        NULL as approver1_status,
        NULL as approver1_date,
        NULL as approver2_name,
        NULL as approver2_status,
        NULL as approver2_date
      FROM jcc_entries j
      JOIN invoices i ON j.invoice_id = i.id
      GROUP BY i.vendor_name, i.status
    `).all();

    const voucherDues = db.prepare(`
      SELECT 
        supplier as vendor_name,
        SUM(CAST(basic_amount AS REAL)) as total_dues,
        CASE
          WHEN status = 'approved' THEN 'approved'
          ELSE 'pending'
        END as status,
        MAX(created_at) as last_updated,
        approver1_name,
        approver1_status,
        approver1_date,
        approver2_name,
        approver2_status,
        approver2_date
      FROM voucher_requests
      WHERE status IN ('approved', 'pending', 'pending_approval_1', 'pending_approval_2')
      GROUP BY supplier, status, approver1_name, approver1_status, approver1_date, approver2_name, approver2_status, approver2_date
    `).all();

    // Combine both
    const vendorDues = [...invoiceDues, ...voucherDues];

    res.json({
      totalDues: totalDues,
      pendingInvoices: pendingInvoicesCount.count + pendingVouchersCount.count,
      approvedInvoices: approvedInvoicesCount.count + approvedVouchersCount.count,
      vendorDues,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get PO budget tracking
router.get('/po-budget', authenticateToken, (req, res) => {
  try {

    // Query purchase_orders and calculate utilization from voucher_requests
    const poBudgetData = db.prepare(`
        SELECT 
            po.po_number as poNumber,
            po.vendor_name as vendorName,
            CAST(po.total_budget AS REAL) as totalAmount,
            COALESCE(used.amount, 0) as usedAmount,
            COALESCE(used.count, 0) as invoiceCount
        FROM purchase_orders po
        LEFT JOIN (
            SELECT 
                po_number, 
                SUM(CAST(basic_amount AS REAL)) as amount,
                COUNT(*) as count
            FROM voucher_requests
            WHERE status != 'rejected' AND po_number IS NOT NULL
            GROUP BY po_number
        ) used ON po.po_number = used.po_number
        WHERE po.status != 'closed'
    `).all();

    const poBudgetWithTotals = poBudgetData.map(po => {
      const remainingAmount = po.totalAmount - po.usedAmount;
      const utilizationPercent = po.totalAmount > 0
        ? ((po.usedAmount / po.totalAmount) * 100).toFixed(1)
        : '0.0';

      return {
        ...po,
        remainingAmount,
        utilizationPercent
      };
    });

    res.json(poBudgetWithTotals);
  } catch (error) {
    console.error('PO Budget error:', error);
    res.status(500).json({ error: 'Failed to fetch PO budget data' });
  }
});

export default router;


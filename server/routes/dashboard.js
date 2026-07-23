import express from 'express';
import db from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get dashboard summary
router.get('/summary', authenticateToken, (req, res) => {
  try {
    // ── Per-user scoping (root-cause fix) ──────────────────────────────────
    // A normal user must only see their OWN JCCs/dues. Only privileged oversight
    // roles get the org-wide view (same access model as GET /api/jcc/vouchers).
    const isPrivileged = ['admin', 'coordinator', 'manager', 'final_approver'].includes(req.user.role);
    const uid = req.user.id;
    // voucher_requests scoping fragment + args
    const vAnd = isPrivileged ? '' : ' AND user_id = ?';
    const vArg = isPrivileged ? [] : [uid];
    // invoices scoping fragment + args (invoices.user_id)
    const iAnd = isPrivileged ? '' : ' AND user_id = ?';
    const iArg = isPrivileged ? [] : [uid];

    // Total dues (jcc_entries via their invoice owner + approved vouchers)
    const jccDuesResult = isPrivileged
      ? db.prepare(`SELECT COALESCE(SUM(approved_amount), 0) as total FROM jcc_entries`).get()
      : db.prepare(`SELECT COALESCE(SUM(j.approved_amount), 0) as total FROM jcc_entries j JOIN invoices i ON j.invoice_id = i.id WHERE i.user_id = ?`).get(uid);

    const voucherDuesResult = db.prepare(`
      SELECT COALESCE(SUM(CAST(basic_amount AS REAL)), 0) as total
      FROM voucher_requests
      WHERE status = 'approved'${vAnd}
    `).get(...vArg);

    const totalDues = jccDuesResult.total + voucherDuesResult.total;

    // Pending counts (invoices + vouchers), scoped
    const pendingInvoicesCount = db.prepare(`
      SELECT COUNT(*) as count FROM invoices
      WHERE status = 'pending'${iAnd}
    `).get(...iArg);

    const pendingVouchersCount = db.prepare(`
      SELECT COUNT(*) as count FROM voucher_requests
      WHERE status IN ('pending', 'pending_approval_1', 'pending_approval_2')${vAnd}
    `).get(...vArg);

    // Approved counts, scoped
    const approvedInvoicesCount = db.prepare(`
      SELECT COUNT(*) as count FROM invoices
      WHERE status = 'approved'${iAnd}
    `).get(...iArg);

    const approvedVouchersCount = db.prepare(`
      SELECT COUNT(*) as count FROM voucher_requests
      WHERE status = 'approved'${vAnd}
    `).get(...vArg);

    // Vendor dues breakdown (combine invoices and vouchers), scoped
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
      ${isPrivileged ? '' : 'WHERE i.user_id = ?'}
      GROUP BY i.vendor_name, i.status
    `).all(...(isPrivileged ? [] : [uid]));

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
      WHERE status IN ('approved', 'pending', 'pending_approval_1', 'pending_approval_2')${vAnd}
      GROUP BY supplier, status, approver1_name, approver1_status, approver1_date, approver2_name, approver2_status, approver2_date
    `).all(...vArg);

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

// Get budget status for a single PO number (used by claim form for real-time warning)
// Optional query param: ?claimAmount=<number> — if provided, also checks whether
// existing_used + new_claim would exceed the budget (wouldExceed flag).
router.get('/po-budget/:poNumber', authenticateToken, (req, res) => {
  try {
    const { poNumber } = req.params;
    const claimAmount = parseFloat(req.query.claimAmount) || 0;

    const po = db.prepare(`
      SELECT po_number, vendor_name, CAST(total_budget AS REAL) as totalAmount
      FROM purchase_orders
      WHERE po_number = ? AND status != 'closed'
      LIMIT 1
    `).get(poNumber);

    if (!po) {
      return res.json({ found: false });
    }

    const used = db.prepare(`
      SELECT COALESCE(SUM(CAST(basic_amount AS REAL)), 0) as usedAmount,
             COUNT(*) as claimCount
      FROM voucher_requests
      WHERE po_number = ? AND status != 'rejected'
    `).get(poNumber);

    const usedAmount = used?.usedAmount || 0;
    const totalAmount = po.totalAmount || 0;
    const remainingAmount = totalAmount - usedAmount;
    const utilizationPercent = totalAmount > 0
      ? parseFloat(((usedAmount / totalAmount) * 100).toFixed(1))
      : 0;

    // Would this new claim push the PO over budget?
    const wouldExceed = claimAmount > 0 && totalAmount > 0 && (usedAmount + claimAmount) > totalAmount;
    const amountAfterClaim = usedAmount + claimAmount;

    res.json({
      found: true,
      poNumber: po.po_number,
      vendorName: po.vendor_name,
      totalAmount,
      usedAmount,
      remainingAmount,
      utilizationPercent,
      claimCount: used?.claimCount || 0,
      isExceeded: remainingAmount < 0,
      isNearLimit: utilizationPercent >= 90 && remainingAmount >= 0,
      wouldExceed,
      amountAfterClaim,
    });
  } catch (error) {
    console.error('PO Budget check error:', error);
    res.status(500).json({ error: 'Failed to check PO budget' });
  }
});

export default router;


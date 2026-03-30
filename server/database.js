import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../database.db');

let db = null;

// Initialize SQL.js database
const initDatabase = async () => {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  let buffer;
  if (fs.existsSync(dbPath)) {
    buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ps_number TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('vendor', 'coordinator', 'admin', 'manager', 'initiator', 'user', 'final_approver')),
      manager_id INTEGER,
      must_change_password INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manager_id) REFERENCES users(id)
    )
  `);


  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vendor_name TEXT,
      invoice_number TEXT,
      amount DECIMAL(10, 2),
      invoice_date DATE,
      file_path TEXT,
      assigned_to TEXT,
      assigned_to_user_id INTEGER,
      assigned_to_name TEXT,
      assigned_by_user_id INTEGER,
      assigned_by_name TEXT,
      assigned_at DATETIME,
      accepted_by_user_id INTEGER,
      accepted_by_name TEXT,
      accepted_at DATETIME,
      voucher_submitted_at DATETIME,
      completed_at DATETIME,
      po_number TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'assigned', 'voucher_created')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invoice_assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_by_user_id INTEGER,
      action_by_name TEXT,
      assigned_to_user_id INTEGER,
      assigned_to_name TEXT,
      voucher_id INTEGER,
      notes TEXT,
      action_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (action_by_user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_to_user_id) REFERENCES users(id)
    )
  `);

  // Purchase Orders Table
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT UNIQUE NOT NULL,
      description TEXT,
      vendor_name TEXT,
      total_budget DECIMAL(15, 2) NOT NULL,
      start_date DATE,
      end_date DATE,
      po_date DATE,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'hold')),
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Migration: Add po_date if it doesn't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(purchase_orders)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const columnNames = columns.map(col => col[1]);

    if (!columnNames.includes('po_date')) {
      console.log('Adding po_date column to purchase_orders table...');
      db.exec('ALTER TABLE purchase_orders ADD COLUMN po_date DATE');
      saveDatabase();
      console.log('✓ po_date column added successfully');
    }
  } catch (error) {
    console.error('Error adding po_date column:', error);
  }

  // Migration: Update invoices table CHECK constraint to include 'voucher_created' status
  try {
    const tableSchema = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'");
    const tableSql = tableSchema.length > 0 && tableSchema[0].values.length > 0 ? tableSchema[0].values[0][0] : '';

    // Check if the table exists but doesn't have 'voucher_created' in the CHECK constraint
    if (tableSql && !tableSql.includes("'voucher_created'")) {
      console.log('Updating invoices table to include voucher_created status...');

      // Create a new table with the updated constraint
      db.exec(`
        CREATE TABLE invoices_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          vendor_name TEXT,
          invoice_number TEXT,
          amount DECIMAL(10, 2),
          invoice_date DATE,
          file_path TEXT,
          assigned_to TEXT,
          po_number TEXT,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'assigned', 'voucher_created')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Copy all data from old table to new table
      db.exec(`
        INSERT INTO invoices_new (id, user_id, vendor_name, invoice_number, amount, invoice_date, file_path, assigned_to, po_number, status, created_at)
        SELECT id, user_id, vendor_name, invoice_number, amount, invoice_date, file_path, assigned_to, po_number, status, created_at
        FROM invoices
      `);

      // Drop old table
      db.exec('DROP TABLE invoices');

      // Rename new table to invoices
      db.exec('ALTER TABLE invoices_new RENAME TO invoices');

      saveDatabase();
      console.log('✓ Invoices table updated with voucher_created status support');
    }
  } catch (error) {
    console.error('Error updating invoices table constraint:', error);
  }

  // Migrate existing invoices table if it doesn't have the new columns
  try {
    const columns = db.exec("PRAGMA table_info(invoices)")[0];
    if (columns) {
      const columnNames = columns.values.map(col => col[1]);
      let didAddInvoiceColumn = false;
      const invoiceColumnsToAdd = [
        { name: 'assigned_to', type: 'TEXT' },
        { name: 'assigned_to_user_id', type: 'INTEGER' },
        { name: 'assigned_to_name', type: 'TEXT' },
        { name: 'assigned_by_user_id', type: 'INTEGER' },
        { name: 'assigned_by_name', type: 'TEXT' },
        { name: 'assigned_at', type: 'DATETIME' },
        { name: 'accepted_by_user_id', type: 'INTEGER' },
        { name: 'accepted_by_name', type: 'TEXT' },
        { name: 'accepted_at', type: 'DATETIME' },
        { name: 'voucher_submitted_at', type: 'DATETIME' },
        { name: 'completed_at', type: 'DATETIME' },
        { name: 'po_number', type: 'TEXT' }
      ];

      invoiceColumnsToAdd.forEach(col => {
        if (!columnNames.includes(col.name)) {
          db.run(`ALTER TABLE invoices ADD COLUMN ${col.name} ${col.type}`);
          console.log(`✓ Added ${col.name} column to invoices`);
          didAddInvoiceColumn = true;
        }
      });

      if (didAddInvoiceColumn) {
        saveDatabase();
      }
    }
  } catch (error) {
    // Table might not exist yet, which is fine
    console.log('Skipping migration check (table might be new)');
  }

  // Migration: Mark existing invoices that have vouchers created as 'voucher_created'
  try {
    const result = db.exec(`
      UPDATE invoices 
      SET status = 'voucher_created' 
      WHERE invoice_number IN (
        SELECT DISTINCT invoice_number FROM voucher_requests WHERE invoice_number IS NOT NULL AND invoice_number != ''
      )
      AND status IN ('pending', 'assigned')
    `);
    console.log('✓ Migrated invoices with existing vouchers to voucher_created status');
  } catch (error) {
    console.log('Note: Could not run invoice migration:', error.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS jcc_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      coordinator_id INTEGER NOT NULL,
      category TEXT,
      description TEXT,
      approved_amount DECIMAL(10, 2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (coordinator_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      claimed_by TEXT,
      department TEXT,
      claimed_date DATE,
      supplier TEXT,
      expense_booking_location TEXT,
      description TEXT,
      invoice_number TEXT,
      invoice_date DATE,
      basic_amount DECIMAL(10, 2),
      gross_amount DECIMAL(10, 2),
      nature_of_expenses TEXT,
      po_number TEXT,
      project_code TEXT,
      project_name TEXT,
      project_amount DECIMAL(10, 2),
      attachment_path TEXT,
      approver1_name TEXT,
      approver1_status TEXT DEFAULT 'pending',
      approver1_remark TEXT,
      approver1_date DATETIME,
      approver2_name TEXT,
      approver2_status TEXT DEFAULT 'pending',
      approver2_remark TEXT,
      approver2_date DATETIME,
      current_approval_level INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending_approval_1',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      amount DECIMAL(10, 2),
      project_code TEXT,
      project_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add approval columns if they don't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(voucher_requests)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const columnNames = columns.map(col => col[1]);

    const columnsToAdd = [
      { name: 'approver1_name', type: 'TEXT' },
      { name: 'approver1_status', type: 'TEXT DEFAULT \'pending\'' },
      { name: 'approver1_remark', type: 'TEXT' },
      { name: 'approver1_date', type: 'DATETIME' },
      { name: 'approver2_name', type: 'TEXT' },
      { name: 'approver2_status', type: 'TEXT DEFAULT \'pending\'' },
      { name: 'approver2_remark', type: 'TEXT' },
      { name: 'approver2_date', type: 'DATETIME' },
      { name: 'current_approval_level', type: 'INTEGER DEFAULT 1' }
    ];

    columnsToAdd.forEach(col => {
      if (!columnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to voucher_requests table...`);
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });

    console.log('✓ Approval columns checked/added');
  } catch (error) {
    console.error('Error checking/adding approval columns:', error);
  }

  // ===== NEW: Customer Management Tables =====

  // Customers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      gst_number TEXT,
      pan_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Vendors table
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_code TEXT UNIQUE NOT NULL,
      vendor_name TEXT NOT NULL,
      address TEXT,
      contact_number TEXT,
      mail_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed vendor master list (idempotent by vendor name)
  try {
    const defaultVendorNames = [
      'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
      'Armoured Vehicles Nigam Limited',
      'Asha Furniture Works',
      'Balaji Arts',
      'Bharat Electronics Limited',
      'CHANDRAHAS SHETTY',
      'DDSPLM Pvt. Ltd.',
      'Delos Consulting Pvt. Ltd.',
      'DesignTech Systems Pvt. Ltd.',
      'GenieHR Solutions Pvt. Ltd.',
      'Global Publishing Solutions Ltd.',
      'Hornbill Studios Pvt Ltd',
      'JUSTVFX STUDIOS',
      'LOUISCIAGA OVERSEAS PVT. LTD',
      'MICROPOINT COMPUTERS PRIVATE LIMITED',
      'Pentagon System And Services Pvt. Ltd',
      'PEREVODRU',
      'PEREVODRU GLOBAL TRANSLATION SERVICES',
      'Pixlar Art Creation',
      'RAC IT SOLUTIONS PVT. LTD.',
      'Schneider Electric India Pvt. Limited (SEIPL)',
      'Shezarweb Technologies',
      'Shivam Computers',
      'SIEMENS INDUSTRY SOFTWARE (INDIA)',
      'Smartify Software Solutions LLP',
      'Somshanti Enterprises',
      'Urgent Courier',
      'Voice Kraft Productions',
      'White Globe Pvt. Ltd.',
      'Track On Courier'
    ];

    const vendorNameExists = (name) => {
      const stmt = db.prepare(`
        SELECT id FROM vendors
        WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
        LIMIT 1
      `);
      stmt.bind([name]);
      const exists = stmt.step();
      stmt.free();
      return exists;
    };

    const vendorCodeExists = (code) => {
      const stmt = db.prepare('SELECT id FROM vendors WHERE vendor_code = ? LIMIT 1');
      stmt.bind([code]);
      const exists = stmt.step();
      stmt.free();
      return exists;
    };

    let seededCount = 0;
    defaultVendorNames.forEach((name, index) => {
      if (vendorNameExists(name)) return;

      let code = `DEF${String(index + 1).padStart(3, '0')}`;
      let suffix = 1;
      while (vendorCodeExists(code)) {
        code = `DEF${String(index + 1).padStart(3, '0')}_${suffix}`;
        suffix += 1;
      }

      db.run(
        'INSERT INTO vendors (vendor_code, vendor_name) VALUES (?, ?)',
        [code, name]
      );
      seededCount += 1;
    });

    if (seededCount > 0) {
      saveDatabase();
      console.log(`✓ Seeded ${seededCount} vendor names into vendor master`);
    }
  } catch (error) {
    console.error('Error seeding vendor names:', error);
  }

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_code TEXT UNIQUE NOT NULL,
      project_name TEXT NOT NULL,
      customer_id INTEGER NOT NULL,
      contract_number TEXT,
      contract_date DATE,
      contract_value DECIMAL(15, 2),
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'active',
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Milestones table
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      milestone_name TEXT NOT NULL,
      description TEXT,
      target_date DATE,
      completion_date DATE,
      status TEXT DEFAULT 'pending',
      value DECIMAL(15, 2),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);

  // Correspondences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_number TEXT UNIQUE NOT NULL,
      project_id INTEGER,
      customer_id INTEGER NOT NULL,
      milestone_id INTEGER,
      subject TEXT NOT NULL,
      content TEXT,
      correspondence_type TEXT DEFAULT 'letter',
      direction TEXT DEFAULT 'outgoing',
      status TEXT DEFAULT 'draft',
      qr_code TEXT,
      digital_signature TEXT,
      sent_date DATETIME,
      received_date DATETIME,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (milestone_id) REFERENCES milestones(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Correspondence attachments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondence_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (correspondence_id) REFERENCES correspondences(id)
    )
  `);

  // Correspondence trail table (audit log)
  db.exec(`
    CREATE TABLE IF NOT EXISTS correspondence_trail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      action_by INTEGER NOT NULL,
      remarks TEXT,
      action_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (correspondence_id) REFERENCES correspondences(id),
      FOREIGN KEY (action_by) REFERENCES users(id)
    )
  `);

  // Add JCC classification columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    if (!voucherColumnNames.includes('jcc_category')) {
      db.exec("ALTER TABLE voucher_requests ADD COLUMN jcc_category TEXT DEFAULT 'general'");
    }
    if (!voucherColumnNames.includes('authority_level')) {
      db.exec("ALTER TABLE voucher_requests ADD COLUMN authority_level TEXT");
    }

    console.log('✓ JCC classification columns checked/added');
  } catch (error) {
    console.error('Error adding JCC classification columns:', error);
  }

  // Add payment tracking columns to voucher_requests
  try {
    const voucherInfo = db.exec("PRAGMA table_info(voucher_requests)");
    const voucherColumns = voucherInfo.length > 0 ? voucherInfo[0].values : [];
    const voucherColumnNames = voucherColumns.map(col => col[1]);

    const paymentColumns = [
      { name: 'payment_status', type: "TEXT DEFAULT 'awaiting_approval'" },
      { name: 'payment_reference', type: 'TEXT' },
      { name: 'payment_remarks', type: 'TEXT' },
      { name: 'payment_submitted_at', type: 'DATETIME' },
      { name: 'payment_initiated_at', type: 'DATETIME' },
      { name: 'payment_debited_at', type: 'DATETIME' },
      { name: 'payment_settled_at', type: 'DATETIME' },
      { name: 'payment_failed_at', type: 'DATETIME' },
      { name: 'payment_reversed_at', type: 'DATETIME' }
    ];

    let didAddPaymentColumn = false;
    paymentColumns.forEach(col => {
      if (!voucherColumnNames.includes(col.name)) {
        db.exec(`ALTER TABLE voucher_requests ADD COLUMN ${col.name} ${col.type}`);
        didAddPaymentColumn = true;
      }
    });

    if (didAddPaymentColumn) {
      saveDatabase();
    }

    console.log('✓ Voucher payment columns checked/added');
  } catch (error) {
    console.error('Error adding voucher payment columns:', error);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_payment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      reference_no TEXT,
      amount DECIMAL(10, 2),
      remarks TEXT,
      action_source TEXT DEFAULT 'manual',
      action_by_user_id INTEGER,
      action_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id),
      FOREIGN KEY (action_by_user_id) REFERENCES users(id)
    )
  `);

  // Materials table for multiple Project Details entries in Voucher Requests
  db.run(`
    CREATE TABLE IF NOT EXISTS voucher_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      amount DECIMAL(10, 2),
      project_code TEXT,
      project_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id)
    )
  `);

  // Asset lifecycle tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_uid TEXT UNIQUE NOT NULL,
      vendor_name TEXT NOT NULL,
      category TEXT,
      asset_name TEXT NOT NULL,
      serial_number TEXT,
      model TEXT,
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'issued', 'returned', 'maintenance', 'lost')),
      daily_rate DECIMAL(10, 2),
      monthly_rate DECIMAL(10, 2),
      remarks TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      assigned_to_name TEXT NOT NULL,
      assigned_to_type TEXT DEFAULT 'employee',
      project_code TEXT,
      location TEXT,
      start_date DATE NOT NULL,
      expected_return_date DATE,
      actual_return_date DATE,
      charge_type TEXT NOT NULL CHECK(charge_type IN ('daily', 'monthly', 'fixed')),
      rate DECIMAL(10, 2),
      fixed_charge DECIMAL(10, 2),
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
      remarks TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      assignment_id INTEGER,
      event_type TEXT NOT NULL CHECK(event_type IN ('created', 'issued', 'returned', 'status_changed', 'charge_updated')),
      event_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      performed_by INTEGER,
      details TEXT,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id),
      FOREIGN KEY (performed_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_asset_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_month TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      total_amount DECIMAL(12, 2) DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'generated', 'finalized')),
      generated_by INTEGER,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(voucher_month, vendor_name),
      FOREIGN KEY (generated_by) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_asset_voucher_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      asset_id INTEGER NOT NULL,
      assignment_id INTEGER NOT NULL,
      billable_start DATE,
      billable_end DATE,
      billable_days INTEGER DEFAULT 0,
      charge_amount DECIMAL(12, 2) NOT NULL,
      charge_type TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES monthly_asset_vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id)
    )
  `);

  console.log('✓ All database tables created successfully');


  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      session_id TEXT,
      device_id TEXT,
      event_name TEXT NOT NULL,
      module TEXT,
      screen TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      duration_ms INTEGER,
      success INTEGER DEFAULT 1,
      status_code INTEGER,
      metadata TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_activity_logs_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_log_id INTEGER,
      user_id INTEGER,
      user_name TEXT,
      session_id TEXT,
      device_id TEXT,
      event_name TEXT NOT NULL,
      module TEXT,
      screen TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      duration_ms INTEGER,
      success INTEGER DEFAULT 1,
      status_code INTEGER,
      metadata TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_log_id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_created_at ON user_activity_logs(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_event_name ON user_activity_logs(event_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_module ON user_activity_logs(module)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id ON user_activity_logs(user_id)');

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO app_settings (key, value) VALUES
      ('session_timeout_hours', '8'),
      ('return_maker_checker_enabled', '0'),
      ('return_reminder_advance_days', '2'),
      ('activity_log_retention_days', '180'),
      ('reminder_email_roles', 'admin,manager,coordinator,final_approver'),
      ('reminder_notification_roles', 'admin,manager,coordinator,final_approver')
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS asset_return_reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      reminder_type TEXT NOT NULL,
      reminder_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(assignment_id, reminder_type, reminder_date),
      FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jcc_approval_reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      approval_level TEXT NOT NULL,
      reminder_date DATE NOT NULL,
      recipients TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(voucher_id, approval_level, reminder_date),
      FOREIGN KEY (voucher_id) REFERENCES voucher_requests(id)
    )
  `);

  // Email event audit log — tracks every send attempt (success/failure)
  db.run(`
    CREATE TABLE IF NOT EXISTS email_event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT,
      template_name TEXT,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      message_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_email_event_logs_status ON email_event_logs(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_email_event_logs_created_at ON email_event_logs(created_at)');

  // ===== DEVICE BINDING & SINGLE SESSION TABLES =====

  db.run(`
    CREATE TABLE IF NOT EXISTS active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS device_bind_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id TEXT,
      action TEXT NOT NULL,
      performed_by INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (performed_by) REFERENCES users(id)
    )
  `);

  console.log('✓ Device binding tables created');

  // Migration: Add return maker-checker columns to asset_assignments
  try {
    const assignmentInfo = db.exec("PRAGMA table_info(asset_assignments)");
    const assignmentColumns = assignmentInfo.length > 0 ? assignmentInfo[0].values : [];
    const assignmentColNames = assignmentColumns.map(col => col[1]);

    const assignmentColumnsToAdd = [
      { name: 'return_request_status', type: "TEXT DEFAULT 'none'" },
      { name: 'return_requested_date', type: 'DATE' },
      { name: 'return_requested_remarks', type: 'TEXT' },
      { name: 'return_requested_by', type: 'INTEGER' },
      { name: 'return_approved_by', type: 'INTEGER' },
      { name: 'return_approved_at', type: 'DATETIME' },
      { name: 'return_rejection_reason', type: 'TEXT' }
    ];

    assignmentColumnsToAdd.forEach(col => {
      if (!assignmentColNames.includes(col.name)) {
        db.run(`ALTER TABLE asset_assignments ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✓ Added ${col.name} column to asset_assignments table`);
      }
    });
  } catch (error) {
    console.error('Error adding maker-checker columns to asset_assignments table:', error);
  }

  // Migration: Add device binding columns to users table
  try {
    const userTableInfoDev = db.exec("PRAGMA table_info(users)");
    const userColsDev = userTableInfoDev.length > 0 ? userTableInfoDev[0].values : [];
    const userColNamesDev = userColsDev.map(col => col[1]);

    const deviceColumns = [
      { name: 'registered_device_id', type: 'TEXT' },
      { name: 'device_bound_at', type: 'DATETIME' },
      { name: 'device_user_agent', type: 'TEXT' },
      { name: 'device_bound_ip', type: 'TEXT' },
      { name: 'device_unbound_at', type: 'DATETIME' },
      { name: 'device_unbound_by', type: 'INTEGER' },
      { name: 'account_limit', type: 'INTEGER DEFAULT 1' }
    ];

    deviceColumns.forEach(col => {
      if (!userColNamesDev.includes(col.name)) {
        console.log(`Adding ${col.name} column to users table...`);
        db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        saveDatabase();
      }
    });

    console.log('✓ Device binding columns checked/added to users table');
  } catch (error) {
    console.error('Error adding device binding columns:', error);
  }

  console.log('✓ Database tables created');

  // Migration: Add attachment_path column if it doesn't exist
  try {
    const tableInfoResult = db.exec("PRAGMA table_info(voucher_requests)");
    const columns = tableInfoResult.length > 0 ? tableInfoResult[0].values : [];
    const hasAttachmentPath = columns.some(col => col[1] === 'attachment_path');

    if (!hasAttachmentPath) {
      console.log('Adding attachment_path column to voucher_requests table...');
      db.exec('ALTER TABLE voucher_requests ADD COLUMN attachment_path TEXT');
      saveDatabase();
      console.log('✓ attachment_path column added successfully');
    }
  } catch (error) {
    console.error('Error adding attachment_path column:', error);
  }

  // Migration: Add ps_number and must_change_password to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    if (!userColumnNames.includes('ps_number')) {
      console.log('Adding ps_number column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN ps_number TEXT');
      saveDatabase();
    }

    if (!userColumnNames.includes('must_change_password')) {
      console.log('Adding must_change_password column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1');
      saveDatabase();
    }

    console.log('✓ User management columns checked/added');
  } catch (error) {
    console.error('Error adding user management columns:', error);
  }

  // Migration: Add login security lockout columns to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    const loginSecurityColumns = [
      { name: 'failed_login_attempts', type: 'INTEGER DEFAULT 0' },
      { name: 'locked_until', type: 'DATETIME' }
    ];

    let didAddLoginSecurityColumn = false;
    loginSecurityColumns.forEach(col => {
      if (!userColumnNames.includes(col.name)) {
        console.log(`Adding ${col.name} column to users table...`);
        db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        didAddLoginSecurityColumn = true;
      }
    });

    if (didAddLoginSecurityColumn) {
      saveDatabase();
    }

    console.log('✓ Login security columns checked/added');
  } catch (error) {
    console.error('Error adding login security columns:', error);
  }

  // Migration: Update role CHECK constraint to include new roles
  try {
    // Check if we need to update the constraint (checking for 'initiator' or 'final_approver')
    const tableSchema = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    const tableSql = tableSchema.length > 0 ? tableSchema[0].values[0][0] : '';

    if (tableSql && !tableSql.includes("'initiator'")) {
      console.log('Updating users table to support new role structure...');

      // Create a new table with the updated constraint
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ps_number TEXT UNIQUE,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('vendor', 'coordinator', 'admin', 'manager', 'initiator', 'user', 'final_approver')),
          manager_id INTEGER,
          must_change_password INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (manager_id) REFERENCES users(id)
        )
      `);

      // Copy all data from old table to new table
      // migrate 'vendor' role to 'initiator'
      db.exec(`
        INSERT INTO users_new (id, ps_number, name, email, password, role, manager_id, must_change_password, created_at)
        SELECT id, ps_number, name, email, password, 
               CASE 
                 WHEN role = 'vendor' THEN 'initiator'
                 ELSE role
               END,
               manager_id, must_change_password, created_at
        FROM users
      `);

      // Drop old table
      db.exec('DROP TABLE users');

      // Rename new table to users
      db.exec('ALTER TABLE users_new RENAME TO users');

      saveDatabase();
      console.log('✓ Users table updated with new roles (initiator, final_approver)');
    }
  } catch (error) {
    console.error('Error updating role constraint:', error);
  }

  // Migration: Add manager_id column to users table
  try {
    const userTableInfo = db.exec("PRAGMA table_info(users)");
    const userColumns = userTableInfo.length > 0 ? userTableInfo[0].values : [];
    const userColumnNames = userColumns.map(col => col[1]);

    if (!userColumnNames.includes('manager_id')) {
      console.log('Adding manager_id column to users table...');
      db.exec('ALTER TABLE users ADD COLUMN manager_id INTEGER');
      saveDatabase();
      console.log('✓ manager_id column added');
    }
  } catch (error) {
    console.error('Error adding manager_id column:', error);
  }


  // Create default users if they don't exist
  const result = db.exec('SELECT COUNT(*) as count FROM users');
  const userCount = result.length > 0 ? result[0].values[0][0] : 0;

  // Drop old letter_templates table if it exists with old schema
  try {
    const tableCheck = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='letter_templates'");
    if (tableCheck.length > 0 && tableCheck[0].values[0][0].includes('template_name')) {
      console.log('Dropping old letter_templates table with outdated schema...');
      db.exec('DROP TABLE IF EXISTS letter_templates');
      saveDatabase();
      console.log('✓ Old letter_templates table dropped');
    }
  } catch (error) {
    console.error('Error checking/dropping old letter_templates table:', error);
  }

  // Create letter management tables
  console.log('Creating letter management tables...');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incoming_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference_number TEXT UNIQUE,
        subject TEXT,
        sender_name TEXT,
        sender_address TEXT,
        received_date DATE,
        original_file_path TEXT,
        ocr_text TEXT,
        ocr_confidence REAL,
        status TEXT DEFAULT 'pending',
        assigned_to INTEGER,
        project_id INTEGER,
        customer_id INTEGER,
        response_letter_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (assigned_to) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS letter_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        template_type TEXT,
        html_content TEXT NOT NULL,
        variables TEXT,
        header_content TEXT,
        footer_content TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER,
        letter_number TEXT UNIQUE,
        subject TEXT,
        recipient_name TEXT,
        recipient_address TEXT,
        project_id INTEGER,
        customer_id INTEGER,
        milestone_id INTEGER,
        in_response_to INTEGER,
        generated_content TEXT,
        pdf_path TEXT,
        qr_code TEXT,
        verification_token TEXT,
        status TEXT DEFAULT 'draft',
        generated_by INTEGER,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        released_at DATETIME,
        FOREIGN KEY (template_id) REFERENCES letter_templates(id),
        FOREIGN KEY (in_response_to) REFERENCES incoming_letters(id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (generated_by) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS letter_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        letter_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        signature_hash TEXT NOT NULL,
        signature_id TEXT UNIQUE,
        signed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (letter_id) REFERENCES generated_letters(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    saveDatabase();
    console.log('✓ Letter management tables created');

    // ===== Seed single Admin user (PS-based login) =====
    try {
      const adminPsNumber = '123455';
      const adminEmail = 'admin@jcc.com';
      const passwordPlain = 'Admin@123';

      // Check if the admin already exists
      const existingAdmin = db.prepare(`
    SELECT id FROM users WHERE ps_number = ?
  `).get(adminPsNumber);

      if (!existingAdmin) {
        const passwordHash = bcrypt.hashSync(passwordPlain, 10);

        db.run(`
      INSERT INTO users (
        ps_number,
        name,
        email,
        password,
        role,
        must_change_password
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
          adminPsNumber,
          'Admin User',
          adminEmail,
          passwordHash,
          'admin',
          0
        ]);

        saveDatabase();

        console.log('✓ Admin user seeded');
        console.log('  PS Number:', adminPsNumber);
        console.log('  Password :', passwordPlain);
      } else {
        console.log('✓ Admin user already exists, skipping seed');
      }
    } catch (err) {
      console.error('Error seeding admin user:', err);
    }
  } catch (error) {
    console.error('Error creating letter management tables:', error);
  }
};

// Save database to file
const saveDatabase = () => {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
};

// Track if we're currently in a transaction
let inTransaction = false;

// Helper function to run queries
const runQuery = (sql, params = []) => {
  // Convert undefined to null for SQL.js compatibility
  const safeParams = (Array.isArray(params) ? params : [params]).map(p => p === undefined ? null : p);
  db.run(sql, safeParams);

  // Get the last inserted row ID
  const result = db.exec('SELECT last_insert_rowid() as id');
  const lastId = result.length > 0 && result[0].values.length > 0
    ? result[0].values[0][0]
    : 0;

  // Only save if we're not in a transaction
  if (!inTransaction) {
    saveDatabase();
  }

  return { lastInsertRowid: lastId };
};

// Helper function to get single row
const getQuery = (sql, params = []) => {
  // Convert undefined to null for SQL.js compatibility
  const safeParams = (Array.isArray(params) ? params : [params]).map(p => p === undefined ? null : p);
  const stmt = db.prepare(sql);
  stmt.bind(safeParams);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
};

// Helper function to get all rows
const allQuery = (sql, params = []) => {
  // Convert undefined to null for SQL.js compatibility
  const safeParams = (Array.isArray(params) ? params : [params]).map(p => p === undefined ? null : p);
  const stmt = db.prepare(sql);
  stmt.bind(safeParams);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
};

// Helper function for transactions
const transaction = (callback) => {
  return () => {
    try {
      inTransaction = true;
      db.run('BEGIN TRANSACTION');
      const result = callback();
      db.run('COMMIT');
      inTransaction = false;
      saveDatabase();
      return result;
    } catch (error) {
      db.run('ROLLBACK');
      inTransaction = false;
      throw error;
    }
  };
};

// Initialize database on module load
await initDatabase();

export default {
  prepare: (sql) => ({
    run: (...params) => runQuery(sql, params),
    get: (...params) => getQuery(sql, params),
    all: (...params) => allQuery(sql, params),
  }),
  exec: (sql) => db.exec(sql),
  transaction,
};

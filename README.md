# JCC Automation System

A comprehensive web application for automating JCC (Joint Consultative Committee) invoice processing, from vendor invoice upload through OCR extraction to live dashboard tracking of vendor dues.

## 🌟 Features

### For Vendors
- **Easy Invoice Upload**: Drag-and-drop interface for uploading invoices (PDF, JPG, PNG)
- **OCR Processing**: Automatic data extraction using Tesseract.js
- **Real-time Status**: Track invoice processing status

### For Coordinators
- **Invoice Verification**: Review OCR-extracted data with preview
- **JCC Entry Creation**: Automated JCC format with minimal manual entry
- **Quick Approval/Rejection**: Streamlined workflow for processing invoices

### For All Users
- **Live Dashboard**: Real-time vendor dues tracking with charts
- **Export Capabilities**: PDF export for reports
- **Role-based Access**: Secure authentication with vendor, coordinator, and admin roles

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager

### Installation

1. **Install dependencies**:
   ```bash
   cd C:\Users\admin\.gemini\antigravity\scratch\jcc-automation
   npm install
   ```

2. **Start the application**:
   ```bash
   npm start
   ```
   
   This will start both the backend server (port 3000) and frontend (port 5173).

3. **Access the application**:
   - Open your browser to `http://localhost:5173`
   - Login with demo credentials (see below)

### Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@jcc.com | admin123 |
| Vendor | vendor@jcc.com | vendor123 |
| Coordinator | coordinator@jcc.com | coord123 |

## 📁 Project Structure

```
jcc-automation/
├── src/                          # Frontend React application
│   ├── components/               # Reusable UI components
│   │   └── Navbar.jsx
│   ├── contexts/                 # React contexts
│   │   └── AuthContext.jsx
│   ├── pages/                    # Page components
│   │   ├── LoginPage.jsx
│   │   ├── VendorUploadPage.jsx
│   │   ├── CoordinatorPage.jsx
│   │   └── DashboardPage.jsx
│   ├── utils/                    # Utility functions
│   │   └── ocrProcessor.js       # OCR logic
│   ├── App.jsx                   # Main app component
│   ├── main.jsx                  # Entry point
│   └── index.css                 # Global styles
├── server/                       # Backend Express server
│   ├── routes/                   # API routes
│   │   ├── auth.js               # Authentication endpoints
│   │   ├── invoices.js           # Invoice management
│   │   ├── jcc.js                # JCC entries
│   │   └── dashboard.js          # Dashboard data
│   ├── middleware/               # Express middleware
│   │   └── auth.js               # JWT authentication
│   ├── database.js               # SQLite database setup
│   └── index.js                  # Server entry point
├── uploads/                      # Uploaded invoice files
├── database.db                   # SQLite database
├── package.json
├── vite.config.js
└── index.html
```

## 🔧 Available Scripts

- `npm start` - Start both frontend and backend concurrently
- `npm run dev` - Start frontend development server only
- `npm run server` - Start backend server only
- `npm run build` - Build frontend for production

## 💡 Usage Workflow

### 1. Vendor Uploads Invoice
- Login as vendor
- Navigate to "Upload Invoice"
- Drag and drop invoice file or click to browse
- OCR automatically extracts invoice data
- Review and edit extracted data if needed
- Submit invoice

### 2. Coordinator Verifies Invoice
- Login as coordinator
- Navigate to "Verify Invoices"
- Review pending invoices with OCR-extracted data
- Select category and approved amount
- Approve to create JCC entry or reject invoice

### 3. View Dashboard
- All users can view the dashboard
- See total vendor dues in real-time
- View charts showing top vendors and invoice status
- Filter and search vendor data
- Export reports to PDF

## 🔐 Security Features

- JWT-based authentication
- Password hashing with bcrypt
- Role-based access control (RBAC)
- Secure file upload validation
- SQL injection prevention with prepared statements

## 🛠️ Technology Stack

**Frontend:**
- React 18
- React Router for navigation
- Chart.js for data visualization
- Tesseract.js for OCR
- jsPDF for PDF export

**Backend:**
- Node.js with Express
- SQLite database (better-sqlite3)
- JWT for authentication
- Multer for file uploads
- bcrypt for password hashing

## 📊 Database Schema

**users**
- id, name, email, password, role, created_at

**invoices**
- id, user_id, vendor_name, invoice_number, amount, invoice_date, file_path, status, created_at

**jcc_entries**
- id, invoice_id, coordinator_id, category, description, approved_amount, created_at

## 🎨 Design Features

- Modern glassmorphism UI
- Dark theme with vibrant accent colors
- Smooth animations and transitions
- Responsive design for all screen sizes
- Premium typography with Inter font

## 📝 License

This project is proprietary software for JCC internal use.

## 👥 Support

For issues or questions, contact the development team.

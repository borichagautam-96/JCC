import React, { useEffect, useMemo, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const MONTH_OPTIONS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const MonthlyVoucherTrackingPage = () => {
  const { getToken } = useAuth();
  const dialog = useDialog();

  const [month, setMonth] = useState(getCurrentMonth());
  const [monthlySummary, setMonthlySummary] = useState([]);
  const [creatorSummary, setCreatorSummary] = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'X-Device-ID': getDeviceId(),
  }), [getToken]);

  const monthlyInsights = useMemo(() => {
    const vendorCount = monthlySummary.length;
    const totalAmount = monthlySummary.reduce((sum, voucher) => sum + Number(voucher.total_amount || 0), 0);
    const totalAssets = monthlySummary.reduce((sum, voucher) => sum + Number(voucher.items?.length || 0), 0);
    return { vendorCount, totalAmount, totalAssets };
  }, [monthlySummary]);

  const [selectedYear, selectedMonthValue] = month.split('-');
  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 9 }, (_, i) => String(currentYear - 4 + i));
  }, []);

  const handleMonthPartChange = (nextMonthValue) => {
    setMonth(`${selectedYear}-${nextMonthValue}`);
  };

  const handleYearPartChange = (nextYear) => {
    setMonth(`${nextYear}-${selectedMonthValue}`);
  };

  const fetchSummary = async (targetMonth = month) => {
    setSummaryLoading(true);
    try {
      const response = await fetch(`/api/assets/monthly-vouchers/summary?month=${encodeURIComponent(targetMonth)}`, {
        headers: authHeaders,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch monthly summary');

      if (Array.isArray(data)) {
        setMonthlySummary(data);
        setCreatorSummary([]);
      } else {
        setMonthlySummary(Array.isArray(data?.vendors) ? data.vendors : []);
        setCreatorSummary(Array.isArray(data?.creators) ? data.creators : []);
      }
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not load monthly summary');
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleGenerateMonthly = async () => {
    try {
      const response = await fetch('/api/assets/monthly-vouchers/generate', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ month }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate monthly vouchers');

      await dialog.alert(`Monthly vouchers generated for ${month}`);
      fetchSummary(month);
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not generate monthly vouchers');
    }
  };

  useEffect(() => {
    fetchSummary(month);
  }, []);

  return (
    <div className="container page-shell fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Monthly Claim Tracking</h1>
          <p className="page-subtitle">Generate monthly billing snapshots and review vendor-level totals in one dedicated workspace.</p>
        </div>
      </div>

      <section className="asset-voucher-section" style={{ marginTop: 0 }}>
        <div className="asset-voucher-header">
          <div>
            <h3 className="asset-voucher-title">Claim Summary</h3>
            <p className="asset-voucher-subtitle">Create and review monthly claim totals by vendor.</p>
          </div>
          <div className="asset-voucher-metrics">
            <div className="asset-voucher-metric">
              <span>Vendors</span>
              <strong>{monthlyInsights.vendorCount}</strong>
            </div>
            <div className="asset-voucher-metric">
              <span>Assets Billed</span>
              <strong>{monthlyInsights.totalAssets}</strong>
            </div>
            <div className="asset-voucher-metric">
              <span>Total Value</span>
              <strong>Rs. {monthlyInsights.totalAmount.toFixed(2)}</strong>
            </div>
          </div>
        </div>

        <div className="asset-voucher-toolbar">
          <div className="voucher-month-picker" role="group" aria-label="Billing month selector">
            <span className="voucher-month-label">Billing Month</span>
            <div className="voucher-month-select-wrap">
              <select
                className="input-field voucher-month-select"
                value={selectedMonthValue}
                onChange={(e) => handleMonthPartChange(e.target.value)}
              >
                {MONTH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                className="input-field voucher-month-select voucher-year-select"
                value={selectedYear}
                onChange={(e) => handleYearPartChange(e.target.value)}
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
          </div>
          <button onClick={() => fetchSummary(month)} className="btn btn-outline">Load Summary</button>
          <button onClick={handleGenerateMonthly} className="btn btn-primary">Generate</button>
        </div>

        {summaryLoading ? <p>Loading monthly claims...</p> : (
          <>
            <div className="asset-voucher-grid">
              {monthlySummary.length === 0 && <p style={{ color: '#6B7280' }}>No monthly claims generated for this month.</p>}
              {monthlySummary.map((voucher) => (
                <div key={voucher.id} className="asset-voucher-card">
                  <div style={{ fontWeight: 700 }}>{voucher.vendor_name}</div>
                  <div style={{ color: '#4B5563', margin: '0.25rem 0' }}>Total: Rs. {Number(voucher.total_amount || 0).toFixed(2)}</div>
                  <div style={{ fontSize: '0.85rem', color: '#6B7280' }}>{voucher.items?.length || 0} assets billed</div>
                </div>
              ))}
            </div>

            <div className="asset-voucher-section" style={{ marginTop: '1rem', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '1rem' }}>
              <h4 style={{ margin: '0 0 0.6rem 0', fontSize: '1.05rem', fontWeight: 700 }}>Created By User</h4>
              {creatorSummary.length === 0 ? (
                <p style={{ color: '#6B7280', margin: 0 }}>No creator-wise claim data for this month.</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>
                        <th style={{ padding: '0.55rem 0.4rem' }}>User</th>
                        <th style={{ padding: '0.55rem 0.4rem' }}>Claims Created</th>
                        <th style={{ padding: '0.55rem 0.4rem' }}>Total Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creatorSummary.map((entry, index) => (
                        <tr key={`${entry.user_id ?? 'unknown'}-${index}`} style={{ borderBottom: '1px solid #F1F5F9' }}>
                          <td style={{ padding: '0.55rem 0.4rem', fontWeight: 600 }}>{entry.user_name || 'Unknown User'}</td>
                          <td style={{ padding: '0.55rem 0.4rem' }}>{Number(entry.voucher_count || 0)}</td>
                          <td style={{ padding: '0.55rem 0.4rem' }}>Rs. {Number(entry.total_amount || 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default MonthlyVoucherTrackingPage;

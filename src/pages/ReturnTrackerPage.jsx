import React, { useEffect, useMemo, useState } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const formatAssetCategory = (category) => {
  const raw = String(category || '').trim();
  if (!raw) return '-';

  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const formatDateLabel = (dateValue) => {
  const raw = String(dateValue || '').trim();
  return raw || '-';
};

const formatCurrentHolder = (asset) => {
  if (asset.status === 'issued' && asset.current_assigned_to_name) {
    return asset.current_assigned_to_name;
  }
  return 'Asset Pool';
};

const getAssetValidityMeta = (asset) => {
  const dueDate = String(asset.current_expected_return_date || '').trim();
  if (!dueDate) {
    return {
      label: asset.status === 'issued' ? 'Due Date Missing' : 'Not Applicable',
      tone: asset.status === 'issued' ? 'warning' : 'neutral',
      dueDate: '-',
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const diffMs = new Date(`${dueDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    return { label: `Expired ${Math.abs(daysLeft)} day(s) ago`, tone: 'danger', dueDate };
  }
  if (daysLeft <= 3) {
    return { label: `Expiring in ${daysLeft} day(s)`, tone: 'warning', dueDate };
  }
  return { label: `Valid (${daysLeft} day(s) left)`, tone: 'success', dueDate };
};

const isOverdue = (row) => {
  if (!row || row.assignment_status !== 'open' || !row.expected_return_date) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(row.expected_return_date) < today;
};

const ReturnTrackerPage = () => {
  const { getToken } = useAuth();
  const dialog = useDialog();

  const [loading, setLoading] = useState(true);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assets, setAssets] = useState([]);
  const [rows, setRows] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [vendorFilter, setVendorFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [assetCategoryFilter, setAssetCategoryFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [historyModal, setHistoryModal] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState(null);
  const [returnForm, setReturnForm] = useState({
    actualReturnDate: new Date().toISOString().slice(0, 10),
    remarks: '',
  });
  const [editingAsset, setEditingAsset] = useState(null);
  const [editAssetSaving, setEditAssetSaving] = useState(false);
  const [editAssetForm, setEditAssetForm] = useState({
    assetUid: '',
    category: 'other',
    assetName: '',
    vendorName: '',
    serialNumber: '',
    model: '',
    dailyRate: '',
    monthlyRate: '',
    remarks: '',
    currentAssignedToName: '',
    currentAssignedOn: '',
    currentExpectedReturnDate: '',
  });

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'X-Device-ID': getDeviceId(),
  }), [getToken]);

  const fetchReturnTrackerFallback = async () => {
    const assetsResponse = await fetch('/api/assets', { headers: authHeaders });
    const assetsData = await assetsResponse.json();

    if (!assetsResponse.ok) {
      throw new Error(assetsData?.error || 'Failed to fetch assets for return tracker fallback');
    }

    const assetsList = Array.isArray(assetsData) ? assetsData : [];
    const historyRows = await Promise.all(
      assetsList.map(async (asset) => {
        try {
          const historyResponse = await fetch(`/api/assets/${asset.id}/history`, { headers: authHeaders });
          const historyData = await historyResponse.json();
          if (!historyResponse.ok) return [];

          const assignments = Array.isArray(historyData?.assignments) ? historyData.assignments : [];
          return assignments.map((assignment) => ({
            assignment_id: assignment.id,
            asset_id: asset.id,
            asset_uid: asset.asset_uid,
            asset_name: asset.asset_name,
            vendor_name: asset.vendor_name,
            category: asset.category,
            assigned_to_name: assignment.assigned_to_name,
            start_date: assignment.start_date,
            expected_return_date: assignment.expected_return_date,
            actual_return_date: assignment.actual_return_date,
            assignment_status: assignment.status,
            return_request_status: assignment.return_request_status || 'none',
            return_requested_date: assignment.return_requested_date,
            return_requested_remarks: assignment.return_requested_remarks,
            return_rejection_reason: assignment.return_rejection_reason,
            return_reason: assignment.remarks,
            updated_at: assignment.updated_at,
          }));
        } catch {
          return [];
        }
      })
    );

    const fallbackRows = historyRows
      .flat()
      .filter((row) => row.assignment_status === 'open' || row.actual_return_date || row.return_request_status === 'rejected')
      .sort((a, b) => {
        if (a.assignment_status === 'open' && b.assignment_status !== 'open') return -1;
        if (a.assignment_status !== 'open' && b.assignment_status === 'open') return 1;
        const aDate = String(a.expected_return_date || a.start_date || '');
        const bDate = String(b.expected_return_date || b.start_date || '');
        return aDate.localeCompare(bDate);
      });

    setRows(fallbackRows);
  };

  const fetchReturnTracker = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/assets/return-tracker', { headers: authHeaders });
      if (response.status === 404) {
        await fetchReturnTrackerFallback();
        return;
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch return tracker');
      setRows(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      try {
        await fetchReturnTrackerFallback();
      } catch (fallbackError) {
        console.error('Return tracker fallback failed:', fallbackError);
        await dialog.alert(error.message || 'Could not load return tracker');
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchAssetsList = async () => {
    setLoadingAssets(true);
    try {
      const response = await fetch('/api/assets', { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch assets');
      setAssets(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not load assets');
    } finally {
      setLoadingAssets(false);
    }
  };

  const vendorOptions = useMemo(() => {
    const values = Array.from(new Set(rows.map((row) => String(row.vendor_name || '').trim()).filter(Boolean)));
    return values.sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const values = Array.from(new Set(rows.map((row) => String(row.category || '').trim()).filter(Boolean)));
    return values.sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();

    return rows.filter((row) => {
      const rowStatus = row.assignment_status === 'open'
        ? row.return_request_status === 'pending'
          ? 'pending_approval'
          : isOverdue(row)
            ? 'overdue'
            : 'to_return'
        : 'returned';
      if (statusFilter !== 'all' && statusFilter !== rowStatus) return false;

      if (vendorFilter !== 'all' && String(row.vendor_name || '') !== vendorFilter) return false;
      if (categoryFilter !== 'all' && String(row.category || '') !== categoryFilter) return false;

      const takenDate = String(row.start_date || '');
      if (fromDate && takenDate && takenDate < fromDate) return false;
      if (toDate && takenDate && takenDate > toDate) return false;

      if (!term) return true;
      const blob = [
        row.asset_uid,
        row.asset_name,
        row.vendor_name,
        row.assigned_to_name,
        row.return_reason,
        row.category,
      ].join(' ').toLowerCase();

      return blob.includes(term);
    });
  }, [rows, searchTerm, statusFilter, vendorFilter, categoryFilter, fromDate, toDate]);

  const metrics = useMemo(() => {
    const toReturn = filteredRows.filter((row) => row.assignment_status === 'open' && row.return_request_status !== 'pending').length;
    const overdue = filteredRows.filter((row) => row.assignment_status === 'open' && row.return_request_status !== 'pending' && isOverdue(row)).length;
    const returned = filteredRows.filter((row) => row.assignment_status !== 'open').length;
    return { toReturn, overdue, returned, total: filteredRows.length };
  }, [filteredRows]);

  const assetCategoryOptions = useMemo(() => {
    const values = Array.from(new Set(assets.map((asset) => String(asset.category || '').trim()).filter(Boolean)));
    return values.sort((a, b) => a.localeCompare(b));
  }, [assets]);

  const filteredAssets = useMemo(() => {
    if (assetCategoryFilter === 'all') return assets;
    return assets.filter((asset) => String(asset.category || '').trim() === assetCategoryFilter);
  }, [assets, assetCategoryFilter]);

  const exportCsv = () => {
    if (filteredRows.length === 0) {
      dialog.alert('No rows available for export.');
      return;
    }

    const headers = [
      'Asset UID',
      'Asset Name',
      'Vendor',
      'Category',
      'Assigned To',
      'Taken Date',
      'Expected Return',
      'Returned On',
      'Return Reason',
      'Status',
    ];

    const csvRows = filteredRows.map((row) => {
      const statusLabel = row.assignment_status === 'open'
        ? row.return_request_status === 'pending'
          ? 'Pending Approval'
          : isOverdue(row)
            ? 'Overdue'
            : row.return_request_status === 'rejected'
              ? 'Rejected'
              : 'To Return'
        : 'Returned';
      const cols = [
        row.asset_uid || '',
        row.asset_name || '',
        row.vendor_name || '',
        formatAssetCategory(row.category),
        row.assigned_to_name || '',
        formatDateLabel(row.start_date),
        formatDateLabel(row.expected_return_date),
        formatDateLabel(row.actual_return_date),
        row.return_reason || '',
        statusLabel,
      ];

      return cols
        .map((value) => `"${String(value || '').replace(/"/g, '""')}"`)
        .join(',');
    });

    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `return-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const openHistory = async (row) => {
    setHistoryModal(row);
    setHistoryLoading(true);
    setHistoryData(null);
    try {
      const response = await fetch(`/api/assets/${row.asset_id}/history`, { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch history');
      setHistoryData(data);
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not load history');
      setHistoryModal(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchReturnTracker();
    fetchAssetsList();
  }, []);

  const handleReturnAsset = async (assetId) => {
    try {
      const response = await fetch(`/api/assets/${assetId}/return`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(returnForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to return asset');

      if (data.pendingApproval) {
        await dialog.alert('Return request submitted for approval.');
      } else {
        await dialog.alert(`Return captured for ${data.actualReturnDate}`);
      }
      fetchReturnTracker();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not return asset');
    }
  };

  const handleApproveReturn = async (row) => {
    try {
      const response = await fetch(`/api/assets/returns/${row.assignment_id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(returnForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to approve return');

      await dialog.alert('Return approved successfully.');
      fetchReturnTracker();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not approve return');
    }
  };

  const handleRejectReturn = async (row) => {
    const reason = (await dialog.prompt('Enter rejection reason', { title: 'Reject return', placeholder: 'Rejection reason (required)…', variant: 'warning' })) || '';
    if (!reason.trim()) {
      await dialog.alert('Rejection reason is required.');
      return;
    }

    try {
      const response = await fetch(`/api/assets/returns/${row.assignment_id}/reject`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to reject return');

      await dialog.alert('Return request rejected.');
      fetchReturnTracker();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not reject return');
    }
  };

  const openEditAssetModal = (asset) => {
    setEditingAsset(asset);
    setEditAssetForm({
      assetUid: asset.asset_uid || '',
      category: asset.category || 'other',
      assetName: asset.asset_name || '',
      vendorName: asset.vendor_name || '',
      serialNumber: asset.serial_number || '',
      model: asset.model || '',
      dailyRate: asset.daily_rate ?? '',
      monthlyRate: asset.monthly_rate ?? '',
      remarks: asset.remarks || '',
      currentAssignedToName: asset.current_assigned_to_name || '',
      currentAssignedOn: asset.current_assigned_on || '',
      currentExpectedReturnDate: asset.current_expected_return_date || '',
    });
  };

  const closeEditAssetModal = () => {
    setEditingAsset(null);
    setEditAssetSaving(false);
  };

  const handleSaveAssetEdit = async () => {
    if (!editingAsset?.id) return;

    setEditAssetSaving(true);
    try {
      const response = await fetch(`/api/assets/${editingAsset.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(editAssetForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update asset');

      await dialog.alert('Asset updated successfully.');
      closeEditAssetModal();
      fetchAssetsList();
      fetchReturnTracker();
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not update asset');
      setEditAssetSaving(false);
    }
  };

  return (
    <div className="container page-shell fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Asset Management</h1>
          <p className="page-subtitle">Review issued assets and capture returns with date and remarks.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4" style={{ marginBottom: '1rem' }}>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600 }}>To Return</div>
          <div style={{ fontSize: '1.7rem', fontWeight: 800, color: 'var(--text-strong)' }}>{metrics.toReturn}</div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <div style={{ color: '#991B1B', fontSize: '0.8rem', fontWeight: 600 }}>Overdue</div>
          <div style={{ fontSize: '1.7rem', fontWeight: 800, color: '#7F1D1D' }}>{metrics.overdue}</div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div style={{ color: '#166534', fontSize: '0.8rem', fontWeight: 600 }}>Returned</div>
          <div style={{ fontSize: '1.7rem', fontWeight: 800, color: '#14532D' }}>{metrics.returned}</div>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div style={{ color: '#1E40AF', fontSize: '0.8rem', fontWeight: 600 }}>Visible Rows</div>
          <div style={{ fontSize: '1.7rem', fontWeight: 800, color: '#1D4ED8' }}>{metrics.total}</div>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginTop: 0 }}>Asset Management</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.5rem' }}>
          <input
            className="input-field"
            type="date"
            value={returnForm.actualReturnDate}
            onChange={(e) => setReturnForm((prev) => ({ ...prev, actualReturnDate: e.target.value }))}
          />
          <input
            className="input-field"
            placeholder="Return remarks (optional)"
            value={returnForm.remarks}
            onChange={(e) => setReturnForm((prev) => ({ ...prev, remarks: e.target.value }))}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr auto', gap: '0.5rem', marginTop: '0.75rem' }}>
          <input
            className="input-field premium-search-field"
            placeholder="Search UID, asset, vendor, assignee..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select className="input-field" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="to_return">To Return</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="overdue">Overdue</option>
            <option value="returned">Returned</option>
          </select>
          <select className="input-field" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
            <option value="all">All Vendors</option>
            {vendorOptions.map((vendor) => (
              <option key={vendor} value={vendor}>{vendor}</option>
            ))}
          </select>
          <select className="input-field" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All Categories</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>{formatAssetCategory(category)}</option>
            ))}
          </select>
          <input className="input-field" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} title="Taken date from" />
          <input className="input-field" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} title="Taken date to" />
          <button type="button" className="btn btn-outline" onClick={exportCsv}>Export CSV</button>
        </div>

        <div style={{ marginTop: '0.9rem' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-body)', marginBottom: '0.45rem' }}>
            What to return and return history
          </div>

          {loading ? (
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading return tracker...</p>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset UID</th>
                    <th>Asset Name</th>
                    <th>Vendor</th>
                    <th>Category</th>
                    <th>Assigned To</th>
                    <th>Taken Date</th>
                    <th>Expected Return</th>
                    <th>Returned On</th>
                    <th>Return Reason</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} style={{ color: 'var(--text-muted)' }}>No issued/return records found for current filters.</td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => (
                      <tr key={row.assignment_id}>
                        <td>{row.asset_uid}</td>
                        <td>{row.asset_name}</td>
                        <td>{row.vendor_name || '-'}</td>
                        <td>{formatAssetCategory(row.category)}</td>
                        <td>{row.assigned_to_name || '-'}</td>
                        <td>{formatDateLabel(row.start_date)}</td>
                        <td>{formatDateLabel(row.expected_return_date)}</td>
                        <td>{formatDateLabel(row.actual_return_date)}</td>
                        <td>{row.return_requested_remarks || row.return_reason || row.return_rejection_reason || '-'}</td>
                        <td>
                          {row.assignment_status === 'open' && row.return_request_status === 'pending' ? (
                            <span className="status-pill" style={{ background: '#FEF3C7', color: '#92400E' }}>Pending Approval</span>
                          ) : row.assignment_status === 'open' && row.return_request_status === 'rejected' ? (
                            <span className="status-pill" style={{ background: '#FEE2E2', color: '#991B1B' }}>Rejected</span>
                          ) : isOverdue(row) ? (
                            <span className="status-pill" style={{ background: '#FEE2E2', color: '#991B1B' }}>Overdue</span>
                          ) : (
                            <span className={`status-pill ${row.assignment_status === 'open' ? 'status-pill-pending' : 'status-pill-approved'}`}>
                              {row.assignment_status === 'open' ? 'To Return' : 'Returned'}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="flex gap-sm">
                            {row.assignment_status === 'open' && row.return_request_status === 'pending' ? (
                              <>
                                <button
                                  onClick={() => handleApproveReturn(row)}
                                  className="btn btn-success"
                                  style={{ padding: '0.35rem 0.7rem' }}
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => handleRejectReturn(row)}
                                  className="btn btn-danger"
                                  style={{ padding: '0.35rem 0.7rem' }}
                                >
                                  Reject
                                </button>
                              </>
                            ) : row.assignment_status === 'open' ? (
                              <button
                                onClick={() => handleReturnAsset(row.asset_id)}
                                className="btn btn-danger"
                                style={{ padding: '0.35rem 0.7rem' }}
                              >
                                Request Return
                              </button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>Completed</span>
                            )}
                            <button
                              type="button"
                              className="btn btn-outline"
                              style={{ padding: '0.35rem 0.7rem' }}
                              onClick={() => openHistory(row)}
                            >
                              History
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ marginTop: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Assets</h3>
        <div className="input-group" style={{ maxWidth: '320px' }}>
          <label className="input-label" htmlFor="asset-management-category-filter">Search by Category</label>
          <select
            id="asset-management-category-filter"
            className="input-field"
            value={assetCategoryFilter}
            onChange={(e) => setAssetCategoryFilter(e.target.value)}
          >
            <option value="all">All Categories</option>
            {assetCategoryOptions.map((category) => (
              <option key={category} value={category}>{formatAssetCategory(category)}</option>
            ))}
          </select>
        </div>

        {loadingAssets ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading assets...</p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Asset UID</th>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Vendor</th>
                  <th>Assigned To</th>
                  <th>Assigned On</th>
                  <th>Current Holder</th>
                  <th>Asset Validity</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ color: 'var(--text-muted)' }}>No assets found for the selected category.</td>
                  </tr>
                ) : (
                  filteredAssets.map((asset) => {
                    const validity = getAssetValidityMeta(asset);
                    const validityStyle = validity.tone === 'danger'
                      ? { background: '#FEE2E2', color: '#991B1B' }
                      : validity.tone === 'warning'
                        ? { background: '#FEF3C7', color: '#92400E' }
                        : validity.tone === 'success'
                          ? { background: '#DCFCE7', color: '#166534' }
                          : { background: 'var(--border)', color: 'var(--text-body)' };

                    return (
                      <tr key={asset.id}>
                        <td>{asset.asset_uid}</td>
                        <td>{formatAssetCategory(asset.category)}</td>
                        <td>{asset.asset_name}</td>
                        <td>{asset.vendor_name}</td>
                        <td>{asset.current_assigned_to_name || '-'}</td>
                        <td>{formatDateLabel(asset.current_assigned_on)}</td>
                        <td>{formatCurrentHolder(asset)}</td>
                        <td>
                          <div style={{ display: 'grid', gap: '0.25rem' }}>
                            <span className="status-pill" style={validityStyle}>{validity.label}</span>
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Due: {validity.dueDate}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`status-pill ${asset.status === 'issued' ? 'status-pill-pending' : 'status-pill-approved'}`}>
                            {asset.status}
                          </span>
                        </td>
                        <td>
                          <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                            <button
                              type="button"
                              onClick={() => openEditAssetModal(asset)}
                              className="btn btn-outline"
                              style={{ padding: '0.35rem 0.7rem' }}
                            >
                              Edit
                            </button>
                            {asset.status === 'issued' ? (
                              <button
                                onClick={() => handleReturnAsset(asset.id)}
                                className="btn btn-danger"
                                style={{ padding: '0.35rem 0.7rem' }}
                              >
                                Request Return
                              </button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>No action</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {historyModal && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-lg">
            <div className="app-modal-header">
              <h3 className="app-modal-title">Asset History - {historyModal.asset_uid}</h3>
              <button className="btn btn-outline" onClick={() => setHistoryModal(null)}>Close</button>
            </div>

            {historyLoading ? (
              <p>Loading history...</p>
            ) : (
              <>
                <div style={{ marginBottom: '0.75rem', color: 'var(--text-body)' }}>
                  <strong>{historyData?.asset?.asset_name || historyModal.asset_name}</strong> | {historyData?.asset?.vendor_name || historyModal.vendor_name}
                </div>

                <div style={{ marginBottom: '0.9rem' }}>
                  <h4 style={{ margin: '0 0 0.4rem 0' }}>Assignments</h4>
                  {historyData?.assignments?.length ? (
                    <div className="table-container">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Assigned To</th>
                            <th>Taken Date</th>
                            <th>Expected Return</th>
                            <th>Returned On</th>
                            <th>Status</th>
                            <th>Remarks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {historyData.assignments.map((item) => (
                            <tr key={item.id}>
                              <td>{item.assigned_to_name}</td>
                              <td>{formatDateLabel(item.start_date)}</td>
                              <td>{formatDateLabel(item.expected_return_date)}</td>
                              <td>{formatDateLabel(item.actual_return_date)}</td>
                              <td>{item.status}</td>
                              <td>{item.remarks || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p style={{ color: 'var(--text-muted)' }}>No assignment history.</p>
                  )}
                </div>

                <div>
                  <h4 style={{ margin: '0 0 0.4rem 0' }}>Event Timeline</h4>
                  {historyData?.events?.length ? (
                    historyData.events.map((event) => (
                      <div key={event.id} style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '0.6rem 0.75rem', marginBottom: '0.5rem' }}>
                        <div style={{ fontWeight: 700 }}>{event.event_type}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{formatDateLabel(event.event_at)} by {event.performed_by_name || 'system'}</div>
                      </div>
                    ))
                  ) : (
                    <p style={{ color: 'var(--text-muted)' }}>No events available.</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {editingAsset && (
        <div className="app-modal-backdrop">
          <div className="app-modal app-modal-md">
            <h3 className="app-modal-title">Edit Asset - {editingAsset.asset_uid}</h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-uid">Asset UID</label>
                <input
                  id="edit-asset-uid"
                  className="input-field"
                  value={editAssetForm.assetUid}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, assetUid: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-category">Category</label>
                <select
                  id="edit-asset-category"
                  className="input-field"
                  value={editAssetForm.category}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, category: e.target.value }))}
                >
                  <option value="laptop">Laptop</option>
                  <option value="workstation">Workstation</option>
                  <option value="monitor">Monitor</option>
                  <option value="printer">Printer</option>
                  <option value="server">Server</option>
                  <option value="ups">UPS</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-name">Asset Name</label>
                <input
                  id="edit-asset-name"
                  className="input-field"
                  value={editAssetForm.assetName}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, assetName: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-vendor">Vendor</label>
                <input
                  id="edit-asset-vendor"
                  className="input-field"
                  value={editAssetForm.vendorName}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, vendorName: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-serial">Serial Number</label>
                <input
                  id="edit-asset-serial"
                  className="input-field"
                  value={editAssetForm.serialNumber}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, serialNumber: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-model">Model</label>
                <input
                  id="edit-asset-model"
                  className="input-field"
                  value={editAssetForm.model}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, model: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-daily-rate">Daily Rate</label>
                <input
                  id="edit-asset-daily-rate"
                  className="input-field"
                  value={editAssetForm.dailyRate}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, dailyRate: e.target.value }))}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-asset-monthly-rate">Monthly Rate</label>
                <input
                  id="edit-asset-monthly-rate"
                  className="input-field"
                  value={editAssetForm.monthlyRate}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, monthlyRate: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="input-group">
                <label className="input-label" htmlFor="edit-current-assigned-to">Assigned To (Current)</label>
                <input
                  id="edit-current-assigned-to"
                  className="input-field"
                  value={editAssetForm.currentAssignedToName}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, currentAssignedToName: e.target.value }))}
                  disabled={editingAsset.status !== 'issued'}
                  placeholder={editingAsset.status === 'issued' ? 'Assigned user name' : 'Only editable when asset is issued'}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-current-expected-return">Return Due On (Current)</label>
                <input
                  id="edit-current-expected-return"
                  type="date"
                  className="input-field"
                  value={editAssetForm.currentExpectedReturnDate}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, currentExpectedReturnDate: e.target.value }))}
                  disabled={editingAsset.status !== 'issued'}
                />
              </div>

              <div className="input-group">
                <label className="input-label" htmlFor="edit-current-assigned-on">Assigned On (Current)</label>
                <input
                  id="edit-current-assigned-on"
                  type="date"
                  className="input-field"
                  value={editAssetForm.currentAssignedOn}
                  onChange={(e) => setEditAssetForm((prev) => ({ ...prev, currentAssignedOn: e.target.value }))}
                  disabled={editingAsset.status !== 'issued'}
                />
              </div>
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="edit-asset-remarks">Remarks</label>
              <textarea
                id="edit-asset-remarks"
                className="input-field"
                rows={3}
                value={editAssetForm.remarks}
                onChange={(e) => setEditAssetForm((prev) => ({ ...prev, remarks: e.target.value }))}
              />
            </div>

            <div className="app-modal-actions">
              <button type="button" className="btn btn-outline" onClick={closeEditAssetModal} disabled={editAssetSaving}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleSaveAssetEdit} disabled={editAssetSaving}>
                {editAssetSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReturnTrackerPage;

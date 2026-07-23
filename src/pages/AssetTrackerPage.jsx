import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const formatAssetCategory = (category) => {
  const raw = String(category || '').trim();
  if (!raw) return '-';

  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const AssetTrackerPage = () => {
  const { getToken } = useAuth();
  const dialog = useDialog();
  const navigate = useNavigate();

  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assets, setAssets] = useState([]);
  const [selectedAssetId, setSelectedAssetId] = useState('');

  const [assetForm, setAssetForm] = useState({
    assetUid: '',
    vendorName: '',
    category: 'laptop',
    assetName: '',
    serialNumber: '',
    model: '',
    dailyRate: '',
    monthlyRate: '',
    remarks: '',
  });

  const [issueForm, setIssueForm] = useState({
    assignedToName: '',
    assignedToType: 'employee',
    projectCode: '',
    location: '',
    startDate: new Date().toISOString().slice(0, 10),
    expectedReturnDate: '',
    chargeType: 'monthly',
    rate: '',
    fixedCharge: '',
    remarks: '',
  });

  const [docFile, setDocFile] = useState(null);
  const [extractingDoc, setExtractingDoc] = useState(false);
  const [extractedDoc, setExtractedDoc] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [autoProcessUpload, setAutoProcessUpload] = useState(true);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState(null);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
    'X-Device-ID': getDeviceId(),
  }), [getToken]);

  const fetchAssets = async () => {
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

  useEffect(() => {
    fetchAssets();
  }, []);

  const resetForms = () => {
    setAssetForm({
      assetUid: '',
      vendorName: '',
      category: 'laptop',
      assetName: '',
      serialNumber: '',
      model: '',
      dailyRate: '',
      monthlyRate: '',
      remarks: '',
    });

    setIssueForm((prev) => ({
      ...prev,
      assignedToName: '',
      projectCode: '',
      location: '',
      expectedReturnDate: '',
      rate: '',
      fixedCharge: '',
      remarks: '',
    }));
  };

  const createAndMaybeIssueAsset = async ({ assetData, issueData }) => {
    const createResponse = await fetch('/api/assets', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(assetData),
    });

    const created = await createResponse.json();
    if (!createResponse.ok) throw new Error(created.error || 'Failed to create asset');

    let issued = false;
    if (issueData?.assignedToName && issueData?.startDate) {
      const issueResponse = await fetch(`/api/assets/${created.assetId}/issue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(issueData),
      });
      const issuePayload = await issueResponse.json();
      if (!issueResponse.ok) throw new Error(issuePayload.error || 'Asset created but failed to issue');
      issued = true;
    }

    resetForms();
    await fetchAssets();

    return { created, issued };
  };

  const handleCreateAsset = async (e) => {
    e.preventDefault();
    try {
      const result = await createAndMaybeIssueAsset({
        assetData: assetForm,
        issueData: issueForm,
      });

      if (result.issued) {
        await dialog.alert(`Asset created and issued successfully. UID: ${result.created.assetUid}`);
      } else {
        await dialog.alert(`Asset created successfully. UID: ${result.created.assetUid}`);
      }
      navigate('/return-tracker');
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not create asset');
    }
  };

  const handleIssueAsset = async (e) => {
    e.preventDefault();

    if (!selectedAssetId) {
      await dialog.alert('Select an asset first.');
      return;
    }

    try {
      const response = await fetch(`/api/assets/${selectedAssetId}/issue`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(issueForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to issue asset');

      await dialog.alert('Asset issued successfully');
      await fetchAssets();
      navigate('/return-tracker');
    } catch (error) {
      console.error(error);
      await dialog.alert(error.message || 'Could not issue asset');
    }
  };

  const applyExtractionToForm = (payload) => {
    if (!payload) return;
    const sourceAsset = payload.assetData || payload;
    const sourceIssue = payload.issueData || payload;
    const firstItem = Array.isArray(payload.items) && payload.items.length > 0 ? payload.items[0] : null;
    let inferredChargeType = null;
    if (sourceIssue.monthlyRate || sourceAsset.monthlyRate) inferredChargeType = 'monthly';
    if (!inferredChargeType && (sourceIssue.dailyRate || sourceAsset.dailyRate)) inferredChargeType = 'daily';

    setAssetForm((prev) => ({
      ...prev,
      assetUid: sourceAsset.assetUid || prev.assetUid,
      vendorName: sourceAsset.vendorName || prev.vendorName,
      assetName: sourceAsset.assetName || firstItem?.assetName || prev.assetName,
      serialNumber: sourceAsset.serialNumber || sourceAsset.assetNumber || firstItem?.assetNumber || prev.serialNumber,
      category: sourceAsset.category || prev.category,
      dailyRate: sourceAsset.dailyRate || firstItem?.dailyRate || prev.dailyRate,
      monthlyRate: sourceAsset.monthlyRate || firstItem?.monthlyRate || prev.monthlyRate,
      remarks: [
        payload.dcNo ? `DC No: ${payload.dcNo}` : '',
        payload.dcDate ? `DC Date: ${payload.dcDate}` : '',
        payload.poNo ? `PO No: ${payload.poNo}` : '',
        payload.poDate ? `PO Date: ${payload.poDate}` : '',
      ].filter(Boolean).join(' | ') || sourceAsset.remarks || prev.remarks,
    }));

    setIssueForm((prev) => ({
      ...prev,
      assignedToName: sourceIssue.assignedToName || prev.assignedToName,
      assignedToType: sourceIssue.assignedToType || prev.assignedToType,
      projectCode: sourceIssue.projectCode || prev.projectCode,
      location: sourceIssue.location || prev.location,
      startDate: sourceIssue.startDate || prev.startDate,
      expectedReturnDate: sourceIssue.expectedReturnDate || prev.expectedReturnDate,
      chargeType: sourceIssue.chargeType || inferredChargeType || prev.chargeType,
      rate: sourceIssue.rate || sourceAsset.monthlyRate || sourceAsset.dailyRate || prev.rate,
      fixedCharge: sourceIssue.fixedCharge || prev.fixedCharge,
      remarks: sourceIssue.remarks || prev.remarks,
    }));
  };

  const handleAnalyzeDocument = async (fileToAnalyze = docFile) => {
    if (!fileToAnalyze) {
      await dialog.alert('Please select an Excel file first.');
      return;
    }

    setExtractingDoc(true);
    setAnalysisStatus(null);
    try {
      const form = new FormData();
      form.append('document', fileToAnalyze);

      const response = await fetch('/api/assets/import-excel/preview', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getToken()}`,
          'X-Device-ID': getDeviceId(),
        },
        body: form,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        const looksLikeHtml = /<!doctype html>|<html/i.test((text || '').trim());
        if (looksLikeHtml) {
          throw new Error('Backend API mismatch detected. Please restart backend server and try upload again.');
        }
        throw new Error(text || 'Unexpected server response while previewing Excel');
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to preview Excel data');

      setImportPreview(data);
      setExtractedDoc(data.firstAutofill || null);
      if (data.firstAutofill) {
        applyExtractionToForm(data.firstAutofill);
      }

      if (autoProcessUpload && data.totalRows === 1 && data.validRows === 1) {
        const row = data.rows?.[0];
        if (row) {
          const result = await createAndMaybeIssueAsset({
            assetData: row.assetData,
            issueData: row.issueData,
          });
          const message = result.issued
            ? `Excel uploaded. Asset auto-created and issued successfully. UID: ${result.created.assetUid}`
            : `Excel uploaded. Asset auto-created successfully. UID: ${result.created.assetUid}`;
          setAnalysisStatus({ type: 'success', message });
          await dialog.alert(message);
          navigate('/return-tracker');
          return;
        }
      }

      const hasInvalid = Number(data.invalidRows || 0) > 0;
      const summaryMessage = hasInvalid
        ? `Excel preview complete. ${data.validRows} valid row(s), ${data.invalidRows} invalid row(s). Fix invalid rows or import only valid rows.`
        : `Excel preview complete. ${data.validRows} valid row(s) ready for import.`;

      setAnalysisStatus({
        type: hasInvalid ? 'warning' : 'success',
        message: summaryMessage,
      });
    } catch (error) {
      console.error(error);
      setAnalysisStatus({
        type: 'error',
        message: error.message || 'Could not preview Excel data',
      });
      await dialog.alert(error.message || 'Could not preview Excel data');
    } finally {
      setExtractingDoc(false);
    }
  };

  const handleBulkImport = async () => {
    if (!docFile) {
      await dialog.alert('Please upload an Excel file first.');
      return;
    }

    setBulkImporting(true);
    try {
      const form = new FormData();
      form.append('document', docFile);
      form.append('autoIssue', 'true');

      const response = await fetch('/api/assets/import-excel/commit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getToken()}`,
          'X-Device-ID': getDeviceId(),
        },
        body: form,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to import Excel rows');

      const summary = `Imported ${data.createdCount}/${data.totalRows} row(s). Issued: ${data.issuedCount}. Failed: ${data.failedCount}.`;
      setAnalysisStatus({
        type: data.failedCount > 0 ? 'warning' : 'success',
        message: summary,
      });

      await fetchAssets();
      await dialog.alert(summary);
      navigate('/return-tracker');
    } catch (error) {
      console.error(error);
      setAnalysisStatus({ type: 'error', message: error.message || 'Bulk import failed' });
      await dialog.alert(error.message || 'Bulk import failed');
    } finally {
      setBulkImporting(false);
    }
  };

  const handleDownloadTemplate = () => {
    const header = [
      'assetUid', 'vendorName', 'category', 'assetName', 'serialNumber', 'model',
      'dailyRate', 'monthlyRate', 'remarks', 'assignedTo', 'issueDate', 'expectedReturnDate',
      'chargeType', 'rate', 'fixedCharge', 'projectCode', 'location', 'issueRemarks',
    ];
    const sample = [
      'AST-2026-000001', 'ABC Rentals', 'laptop', 'Dell Latitude 5440', 'SN-12345', 'i7/16GB/512GB',
      '200', '4500', 'Office use', 'Gautam', '2026-03-24', '2026-04-24',
      'monthly', '4500', '', 'PJT-001', 'Head Office', 'Issued for project work',
    ];

    const csv = `${header.join(',')}\n${sample.join(',')}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.setAttribute('download', 'asset-import-template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const inputClass = 'input-field';

  return (
    <div className="container page-shell fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Asset Lifecycle Tracker</h1>
          <p className="page-subtitle">Track issue date, return date, and billing details by unique asset ID.</p>
        </div>
      </div>

      {analysisStatus && (
        <div
          className="mb-lg"
          style={{
            padding: '0.85rem 1rem',
            borderRadius: '10px',
            border: analysisStatus.type === 'success'
              ? '1px solid #86efac'
              : analysisStatus.type === 'warning'
                ? '1px solid #fcd34d'
                : '1px solid #fca5a5',
            background: analysisStatus.type === 'success'
              ? '#f0fdf4'
              : analysisStatus.type === 'warning'
                ? '#fffbeb'
                : '#fef2f2',
            color: analysisStatus.type === 'success'
              ? '#166534'
              : analysisStatus.type === 'warning'
                ? '#92400e'
                : '#991b1b',
            fontWeight: 600,
          }}
        >
          {analysisStatus.message}
        </div>
      )}

      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', alignItems: 'start' }}>
        <form onSubmit={handleCreateAsset} className="glass-card">
          <h3 style={{ marginTop: 0 }}>Create Asset</h3>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-doc-upload">Upload Excel File</label>
            <input
              id="asset-doc-upload"
              type="file"
              accept=".xls,.xlsx,.csv"
              className={inputClass}
              onChange={async (e) => {
                const file = e.target.files?.[0] || null;
                setDocFile(file);
                if (file) {
                  await handleAnalyzeDocument(file);
                }
              }}
            />
          </div>
          <div className="flex gap-sm mb-md" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-outline" onClick={handleDownloadTemplate}>
              Download Excel Template
            </button>
            {importPreview?.totalRows > 1 && (
              <button type="button" className="btn btn-secondary" onClick={handleBulkImport} disabled={bulkImporting || extractingDoc}>
                {bulkImporting ? 'Importing...' : `Import Valid Rows (${importPreview.validRows})`}
              </button>
            )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.84rem', color: 'var(--text-body)' }}>
              <input
                type="checkbox"
                checked={autoProcessUpload}
                onChange={(e) => setAutoProcessUpload(e.target.checked)}
              />
              Auto-create and auto-issue when Excel has exactly 1 valid row
            </label>
          </div>
          {extractingDoc && (
            <div className="mb-md" style={{ fontSize: '0.86rem', color: 'var(--text-body)', fontWeight: 600 }}>
              Reading Excel file and auto-filling fields...
            </div>
          )}

          {extractedDoc && (
            <div className="mb-md" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.75rem' }}>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginBottom: '0.35rem', fontWeight: 600 }}>Extracted Summary</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-body)' }}>
                Vendor: {extractedDoc.assetData?.vendorName || extractedDoc.vendorName || '-'} | Asset: {extractedDoc.assetData?.assetName || extractedDoc.assetName || '-'} | Category: {extractedDoc.assetData?.category || extractedDoc.category || '-'}
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginTop: '0.25rem' }}>
                Assigned To: {extractedDoc.issueData?.assignedToName || extractedDoc.assignedToName || '-'} | Issue Date: {extractedDoc.issueData?.startDate || extractedDoc.startDate || '-'} | Expected Return: {extractedDoc.issueData?.expectedReturnDate || extractedDoc.expectedReturnDate || '-'}
              </div>
            </div>
          )}

          {importPreview && (
            <div className="mb-md" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '0.75rem' }}>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-body)', marginBottom: '0.35rem', fontWeight: 700 }}>
                Validation Report
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-body)', marginBottom: '0.45rem' }}>
                Total rows: {importPreview.totalRows} | Valid: {importPreview.validRows} | Invalid: {importPreview.invalidRows}
              </div>
              <div style={{ maxHeight: '180px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-3)' }}>
                      <th style={{ textAlign: 'left', padding: '0.45rem' }}>Row</th>
                      <th style={{ textAlign: 'left', padding: '0.45rem' }}>Status</th>
                      <th style={{ textAlign: 'left', padding: '0.45rem' }}>Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(importPreview.rows || []).slice(0, 15).map((row) => (
                      <tr key={row.rowNumber} style={{ borderTop: '1px solid var(--surface-3)' }}>
                        <td style={{ padding: '0.45rem' }}>{row.rowNumber}</td>
                        <td style={{ padding: '0.45rem', color: row.isValid ? '#166534' : '#991b1b', fontWeight: 600 }}>
                          {row.isValid ? 'Valid' : 'Invalid'}
                        </td>
                        <td style={{ padding: '0.45rem', color: 'var(--text-body)' }}>
                          {row.errors?.length ? row.errors.join(', ') : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(importPreview.rows || []).length > 15 && (
                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                  Showing first 15 rows. Import will process all rows.
                </div>
              )}
            </div>
          )}

          <div className="input-group">
            <label className="input-label" htmlFor="asset-uid">Unique ID (Optional)</label>
            <input id="asset-uid" className={inputClass} value={assetForm.assetUid} onChange={(e) => setAssetForm({ ...assetForm, assetUid: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-category">Category</label>
            <select id="asset-category" className={inputClass} value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })}>
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
            <label className="input-label" htmlFor="asset-vendor">Vendor Name</label>
            <input id="asset-vendor" required className={inputClass} value={assetForm.vendorName} onChange={(e) => setAssetForm({ ...assetForm, vendorName: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-name">Asset Name</label>
            <input id="asset-name" required className={inputClass} value={assetForm.assetName} onChange={(e) => setAssetForm({ ...assetForm, assetName: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-serial">Serial Number</label>
            <input id="asset-serial" className={inputClass} value={assetForm.serialNumber} onChange={(e) => setAssetForm({ ...assetForm, serialNumber: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-model">Model</label>
            <input id="asset-model" className={inputClass} value={assetForm.model} onChange={(e) => setAssetForm({ ...assetForm, model: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div className="input-group">
              <label className="input-label" htmlFor="asset-daily-rate">Daily Rate</label>
              <input id="asset-daily-rate" className={inputClass} value={assetForm.dailyRate} onChange={(e) => setAssetForm({ ...assetForm, dailyRate: e.target.value })} />
            </div>
            <div className="input-group">
              <label className="input-label" htmlFor="asset-monthly-rate">Monthly Rate</label>
              <input id="asset-monthly-rate" className={inputClass} value={assetForm.monthlyRate} onChange={(e) => setAssetForm({ ...assetForm, monthlyRate: e.target.value })} />
            </div>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="asset-remarks">Remarks</label>
            <textarea id="asset-remarks" className={inputClass} rows={3} value={assetForm.remarks} onChange={(e) => setAssetForm({ ...assetForm, remarks: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-primary">Create</button>
        </form>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <form onSubmit={handleIssueAsset} className="glass-card">
          <h3 style={{ marginTop: 0 }}>Issue Asset</h3>
          <div className="input-group">
            <label className="input-label" htmlFor="issue-asset-select">Select Asset</label>
            <select id="issue-asset-select" required className={inputClass} value={selectedAssetId} onChange={(e) => setSelectedAssetId(e.target.value)}>
              <option value="">Select Asset</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.asset_uid} | {formatAssetCategory(asset.category)} | {asset.asset_name} | {asset.status}</option>
              ))}
            </select>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="issue-assigned-to">Assigned To</label>
            <input id="issue-assigned-to" required className={inputClass} value={issueForm.assignedToName} onChange={(e) => setIssueForm({ ...issueForm, assignedToName: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div className="input-group">
              <label className="input-label" htmlFor="issue-date">Issue Date</label>
              <input id="issue-date" required type="date" className={inputClass} value={issueForm.startDate} onChange={(e) => setIssueForm({ ...issueForm, startDate: e.target.value })} />
            </div>
            <div className="input-group">
              <label className="input-label" htmlFor="issue-expected-return">Expected Return Date</label>
              <input id="issue-expected-return" type="date" className={inputClass} value={issueForm.expectedReturnDate} onChange={(e) => setIssueForm({ ...issueForm, expectedReturnDate: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div className="input-group">
              <label className="input-label" htmlFor="issue-billing-cycle">Billing Cycle</label>
              <select id="issue-billing-cycle" className={inputClass} value={issueForm.chargeType} onChange={(e) => setIssueForm({ ...issueForm, chargeType: e.target.value })}>
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="fixed">Fixed</option>
              </select>
            </div>
            <div className="input-group">
              <label className="input-label" htmlFor="issue-rate">Rate / Fixed Charge</label>
              <input id="issue-rate" className={inputClass} value={issueForm.chargeType === 'fixed' ? issueForm.fixedCharge : issueForm.rate} onChange={(e) => issueForm.chargeType === 'fixed' ? setIssueForm({ ...issueForm, fixedCharge: e.target.value }) : setIssueForm({ ...issueForm, rate: e.target.value })} />
            </div>
          </div>
          <button type="submit" className="btn btn-success">Issue</button>
          </form>

        </div>
      </div>

    </div>
  );
};

export default AssetTrackerPage;

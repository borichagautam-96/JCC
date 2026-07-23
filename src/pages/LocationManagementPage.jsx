import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const LocationManagementPage = () => {
    const { getToken } = useAuth();
    const dialog = useDialog();
    const [locations, setLocations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [newCode, setNewCode] = useState('');
    const [busy, setBusy] = useState(false);

    const authHeaders = () => ({
        Authorization: `Bearer ${getToken()}`,
        'X-Device-ID': getDeviceId(),
        'Content-Type': 'application/json',
    });

    const fetchLocations = useCallback(async () => {
        try {
            const res = await fetch('/api/locations?all=1', { headers: authHeaders() });
            if (res.ok) setLocations(await res.json());
        } catch (e) {
            console.error('location fetch failed', e);
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    useEffect(() => { fetchLocations(); }, [fetchLocations]);

    const addLocation = async () => {
        if (!newName.trim()) { await dialog.alert('Location name is required.', { title: 'Missing name', variant: 'warning' }); return; }
        setBusy(true);
        try {
            const res = await fetch('/api/locations', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ name: newName.trim(), code: newCode.trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to add');
            setNewName(''); setNewCode('');
            await fetchLocations();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const saveLocation = async (loc, patch) => {
        try {
            const res = await fetch(`/api/locations/${loc.id}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({ name: loc.name, code: loc.code, active: loc.active, ...patch }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update');
            await fetchLocations();
        } catch (e) {
            await dialog.alert(e.message, { title: 'Error', variant: 'error' });
        }
    };

    const updateField = (id, field, value) => {
        setLocations((prev) => prev.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
    };

    if (loading) {
        return <div className="flex items-center justify-center" style={{ minHeight: '80vh' }}><div className="spinner"></div></div>;
    }

    return (
        <div className="container page-shell">
            <div className="fade-in">
                <div className="page-header">
                    <div>
                        <h1 className="page-title">Location Management</h1>
                        <p className="page-subtitle">Sites used to route print jobs to the right coordinator and operators</p>
                    </div>
                </div>

                {/* Add */}
                <div className="glass-card" style={{ marginBottom: 'var(--spacing-xl)' }}>
                    <h3 style={{ marginTop: 0, color: 'var(--text-strong)' }}>Add Location</h3>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <div className="input-group" style={{ flex: '1 1 220px' }}>
                            <label className="input-label">Name <span style={{ color: '#DC2626' }}>*</span></label>
                            <input className="input-field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Talegaon" />
                        </div>
                        <div className="input-group" style={{ flex: '0 1 160px' }}>
                            <label className="input-label">Code</label>
                            <input className="input-field" value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="e.g. TLG" />
                        </div>
                        <button className="btn btn-primary" onClick={addLocation} disabled={busy} style={{ marginBottom: '2px' }}>+ Add</button>
                    </div>
                </div>

                {/* List */}
                <div className="glass-card">
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr><th>Name</th><th>Code</th><th>Status</th><th style={{ textAlign: 'center' }}>Actions</th></tr>
                            </thead>
                            <tbody>
                                {locations.length === 0 ? (
                                    <tr><td colSpan="4" className="text-center" style={{ color: '#999', padding: '2rem' }}>No locations yet. Add one above.</td></tr>
                                ) : locations.map((loc) => (
                                    <tr key={loc.id} style={{ opacity: loc.active ? 1 : 0.55 }}>
                                        <td>
                                            <input className="input-field" style={{ maxWidth: '220px' }} value={loc.name} onChange={(e) => updateField(loc.id, 'name', e.target.value)} />
                                        </td>
                                        <td>
                                            <input className="input-field" style={{ maxWidth: '120px' }} value={loc.code || ''} onChange={(e) => updateField(loc.id, 'code', e.target.value)} />
                                        </td>
                                        <td>
                                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${loc.active ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}`}>
                                                {loc.active ? 'Active' : 'Inactive'}
                                            </span>
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                <button className="btn btn-sm btn-primary" onClick={() => saveLocation(loc, {})}>Save</button>
                                                <button className="btn btn-sm btn-outline" onClick={() => saveLocation(loc, { active: loc.active ? 0 : 1 })}>
                                                    {loc.active ? 'Deactivate' : 'Activate'}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LocationManagementPage;

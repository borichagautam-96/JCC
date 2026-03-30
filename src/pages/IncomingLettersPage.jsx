import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { useNavigate } from 'react-router-dom';

const IncomingLettersPage = () => {
    const [letters, setLetters] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const { getToken } = useAuth();
    const navigate = useNavigate();
    const dialog = useDialog();

    useEffect(() => {
        fetchLetters();
    }, [statusFilter]);

    const fetchLetters = async () => {
        try {
            let url = '/api/letters/incoming';
            const params = new URLSearchParams();
            if (statusFilter) params.append('status', statusFilter);
            if (searchTerm) params.append('search', searchTerm);
            if (params.toString()) url += `?${params.toString()}`;

            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            const data = await response.json();
            setLetters(data);
        } catch (error) {
            console.error('Error fetching letters:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setUploading(true);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/letters/incoming/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() },
                body: formData
            });

            if (response.ok) {
                const result = await response.json();
                await dialog.alert(`Letter uploaded successfully! Reference: ${result.referenceNumber}`);
                fetchLetters();

                // Automatically trigger OCR processing
                await processOCR(result.letterId);
            } else {
                await dialog.alert('Failed to upload letter');
            }
        } catch (error) {
            console.error('Upload error:', error);
            await dialog.alert('Failed to upload letter');
        } finally {
            setUploading(false);
            e.target.value = '';
        }
    };

    const processOCR = async (letterId) => {
        try {
            const response = await fetch(`/api/letters/incoming/${letterId}/ocr`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });

            if (response.ok) {
                const result = await response.json();
                console.log('OCR processed:', result);
                fetchLetters();
            }
        } catch (error) {
            console.error('OCR error:', error);
        }
    };

    const getStatusBadge = (status) => {
        const statusStyles = {
            pending: { bg: '#FEF3C7', text: '#92400E', label: 'Pending' },
            processing: { bg: '#DBEAFE', text: '#1E40AF', label: 'Processing' },
            read: { bg: '#E0E7FF', text: '#3730A3', label: 'Read' },
            responded: { bg: '#D1FAE5', text: '#065F46', label: 'Responded' },
            released: { bg: '#F3E8FF', text: '#6B21A8', label: 'Released' }
        };

        const style = statusStyles[status] || statusStyles.pending;
        return (
            <span style={{
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '0.875rem',
                fontWeight: 600,
                backgroundColor: style.bg,
                color: style.text
            }}>
                {style.label}
            </span>
        );
    };

    const filteredLetters = letters.filter(letter => {
        if (!searchTerm) return true;
        const search = searchTerm.toLowerCase();
        return (
            (letter.reference_number || '').toLowerCase().includes(search) ||
            (letter.subject || '').toLowerCase().includes(search) ||
            (letter.sender_name || '').toLowerCase().includes(search)
        );
    });

    return (
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{
                background: '#0066CC',
                color: 'white',
                padding: '1.5rem 2rem',
                borderRadius: '8px',
                marginBottom: '2rem'
            }}>
                <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>
                    Incoming Letters
                </h1>
                <p style={{ margin: '0.5rem 0 0 0', opacity: 0.95, color: 'white' }}>
                    Upload, process with OCR, and manage incoming correspondence
                </p>
            </div>

            {/* Upload Section */}
            <div style={{
                background: 'white',
                border: '2px dashed #D1D5DB',
                borderRadius: '8px',
                padding: '2rem',
                marginBottom: '2rem',
                textAlign: 'center',
                transition: 'all 0.3s'
            }}>
                <input
                    type="file"
                    id="letterUpload"
                    accept="image/*,.pdf"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    style={{ display: 'none' }}
                />
                <label htmlFor="letterUpload" style={{
                    display: 'inline-block',
                    padding: '0.75rem 1.5rem',
                    background: uploading ? '#9CA3AF' : '#0066CC',
                    color: 'white',
                    borderRadius: '6px',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: '1rem',
                    transition: 'background 0.2s'
                }}>
                    {uploading ? 'Uploading & Processing...' : 'Upload Scanned Letter'}
                </label>
                <p style={{ marginTop: '1rem', color: '#6B7280', fontSize: '0.875rem' }}>
                    Supports JPG, PNG, and PDF files (Max 20MB)
                </p>
            </div>

            {/* Filters */}
            <div style={{
                background: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: '8px',
                padding: '1.5rem',
                marginBottom: '1.5rem'
            }}>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '300px' }}>
                        <input
                            type="text"
                            placeholder="Search by reference, subject, or sender..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '0.75rem 1rem',
                                border: '1px solid #D1D5DB',
                                borderRadius: '6px',
                                fontSize: '1rem'
                            }}
                        />
                    </div>
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={{
                            padding: '0.75rem 1rem',
                            border: '1px solid #D1D5DB',
                            borderRadius: '6px',
                            fontSize: '1rem',
                            background: 'white'
                        }}
                    >
                        <option value="">All Statuses</option>
                        <option value="pending">Pending</option>
                        <option value="processing">Processing</option>
                        <option value="read">Read</option>
                        <option value="responded">Responded</option>
                        <option value="released">Released</option>
                    </select>
                    <button
                        onClick={fetchLetters}
                        style={{
                            padding: '0.75rem 1.5rem',
                            background: '#0066CC',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontWeight: 600
                        }}
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {/* Letters Table */}
            <div style={{
                background: 'white',
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
            }}>
                {loading ? (
                    <div style={{ padding: '3rem', textAlign: 'center' }}>
                        <p>Loading letters...</p>
                    </div>
                ) : filteredLetters.length === 0 ? (
                    <div style={{ padding: '3rem', textAlign: 'center', color: '#9CA3AF' }}>
                        <p>No incoming letters found. Upload a scanned letter to get started.</p>
                    </div>
                ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#F9FAFB' }}>
                            <tr>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>Reference</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>Subject</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>Sender</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>Received</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>Status</th>
                                <th style={{ padding: '1rem', textAlign: 'left', fontWeight: 600 }}>OCR</th>
                                <th style={{ padding: '1rem', textAlign: 'center', fontWeight: 600 }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredLetters.map((letter) => (
                                <tr key={letter.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                                    <td style={{ padding: '1rem', fontFamily: 'monospace', fontWeight: 600, color: '#0066CC' }}>
                                        {letter.reference_number}
                                    </td>
                                    <td style={{ padding: '1rem' }}>{letter.subject || '-'}</td>
                                    <td style={{ padding: '1rem' }}>{letter.sender_name || '-'}</td>
                                    <td style={{ padding: '1rem', color: '#6B7280' }}>
                                        {letter.received_date ? new Date(letter.received_date).toLocaleDateString() : '-'}
                                    </td>
                                    <td style={{ padding: '1rem' }}>{getStatusBadge(letter.status)}</td>
                                    <td style={{ padding: '1rem' }}>
                                        {letter.ocr_confidence ? (
                                            <span style={{ color: letter.ocr_confidence > 80 ? '#10B981' : '#F59E0B' }}>
                                                {letter.ocr_confidence.toFixed(0)}%
                                            </span>
                                        ) : '-'}
                                    </td>
                                    <td style={{ padding: '1rem', textAlign: 'center' }}>
                                        <button
                                            onClick={() => navigate(`/letters/incoming/${letter.id}`)}
                                            style={{
                                                padding: '0.5rem 1rem',
                                                background: '#0066CC',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: '6px',
                                                cursor: 'pointer',
                                                fontSize: '0.875rem',
                                                fontWeight: 600
                                            }}
                                        >
                                            View →
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Summary Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginTop: '2rem' }}>
                {['pending', 'processing', 'read', 'responded', 'released'].map(status => (
                    <div key={status} style={{
                        background: 'white',
                        padding: '1.5rem',
                        borderRadius: '8px',
                        border: '1px solid #E5E7EB',
                        textAlign: 'center'
                    }}>
                        <div style={{ fontSize: '0.875rem', color: '#6B7280', marginBottom: '0.5rem', textTransform: 'capitalize' }}>
                            {status}
                        </div>
                        <div style={{ fontSize: '2rem', fontWeight: 700, color: '#0066CC' }}>
                            {letters.filter(l => l.status === status).length}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default IncomingLettersPage;

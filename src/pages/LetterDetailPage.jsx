import React, { useState, useEffect } from 'react';
import DatePicker from '../components/DatePicker';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';

const LetterDetailPage = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { getToken, user } = useAuth();
    const dialog = useDialog();
    const [letter, setLetter] = useState(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [formData, setFormData] = useState({});
    const [showResponseModal, setShowResponseModal] = useState(false);
    const [responseData, setResponseData] = useState({
        subject: '',
        recipient_name: '',
        recipient_address: '',
        content: ''
    });

    useEffect(() => {
        fetchLetterDetails();
    }, [id]);

    const fetchLetterDetails = async () => {
        try {
            const response = await fetch(`/api/letters/incoming/${id}`, {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            const data = await response.json();
            setLetter(data);
            setFormData(data);
        } catch (error) {
            console.error('Error fetching letter:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleUpdate = async () => {
        try {
            const response = await fetch(`/api/letters/incoming/${id}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            if (response.ok) {
                await dialog.alert('Letter updated successfully');
                setEditing(false);
                fetchLetterDetails();
            }
        } catch (error) {
            console.error('Update error:', error);
            await dialog.alert('Failed to update letter');
        }
    };

    const handleCreateResponse = async () => {
        try {
            const response = await fetch(`/api/letters/incoming/${id}/respond`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(responseData)
            });

            if (response.ok) {
                const result = await response.json();
                await dialog.alert(`Response created! Letter Number: ${result.letterNumber}`);
                setShowResponseModal(false);
                fetchLetterDetails();
            }
        } catch (error) {
            console.error('Response creation error:', error);
            await dialog.alert('Failed to create response');
        }
    };

    const handleRelease = async () => {
        const confirmed = await dialog.confirm('Are you sure you want to release this letter?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/letters/incoming/${id}/release`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });

            if (response.ok) {
                await dialog.alert('Letter released successfully');
                fetchLetterDetails();
            }
        } catch (error) {
            console.error('Release error:', error);
            await dialog.alert('Failed to release letter');
        }
    };

    if (loading) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading letter details...</div>;
    }

    if (!letter) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Letter not found</div>;
    }

    return (
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <div>
                    <button
                        onClick={() => navigate('/letters/incoming')}
                        style={{
                            padding: '0.5rem 1rem',
                            background: '#6B7280',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            marginBottom: '1rem'
                        }}
                    >
                        ← Back to Letters
                    </button>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>
                        {letter.reference_number}
                    </h1>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {editing ? (
                        <>
                            <button onClick={handleUpdate} style={{
                                padding: '0.75rem 1.5rem',
                                background: '#10B981',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 600
                            }}>
                                Save
                            </button>
                            <button onClick={() => setEditing(false)} style={{
                                padding: '0.75rem 1.5rem',
                                background: '#EF4444',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 600
                            }}>
                                ✕ Cancel
                            </button>
                        </>
                    ) : (
                        <>
                            <button onClick={() => setEditing(true)} style={{
                                padding: '0.75rem 1.5rem',
                                background: '#0066CC',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 600
                            }}>
                                Edit
                            </button>
                            {letter.status !== 'responded' && (
                                <button onClick={() => setShowResponseModal(true)} style={{
                                    padding: '0.75rem 1.5rem',
                                    background: '#10B981',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: 600
                                }}>
                                    Respond
                                </button>
                            )}
                            {(user?.role === 'admin' || user?.role === 'manager') && letter.status !== 'released' && (
                                <button onClick={handleRelease} style={{
                                    padding: '0.75rem 1.5rem',
                                    background: '#8B5CF6',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: 600
                                }}>
                                    Release
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                {/* Left: Scanned Image */}
                <div style={{
                    background: 'var(--surface)',
                    padding: '1.5rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border)'
                }}>
                    <h3 style={{ marginTop: 0 }}>Scanned Document</h3>
                    {letter.original_file_path ? (
                        <img
                            src={letter.original_file_path}
                            alt="Scanned letter"
                            style={{
                                width: '100%',
                                border: '1px solid var(--border)',
                                borderRadius: '4px'
                            }}
                        />
                    ) : (
                        <div style={{
                            padding: '3rem',
                            textAlign: 'center',
                            background: 'var(--surface-2)',
                            border: '1px dashed var(--border)',
                            borderRadius: '4px',
                            color: 'var(--text-faint)'
                        }}>
                            No scanned document available
                        </div>
                    )}
                </div>

                {/* Right: Letter Details */}
                <div style={{
                    background: 'var(--surface)',
                    padding: '1.5rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border)'
                }}>
                    <h3 style={{ marginTop: 0 }}>Letter Details</h3>

                    <div style={{ marginBottom: '1rem' }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>Subject</label>
                        {editing ? (
                            <input
                                type="text"
                                value={formData.subject || ''}
                                onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        ) : (
                            <p style={{ margin: 0, color: 'var(--text-muted)' }}>{letter.subject || '-'}</p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>Sender Name</label>
                        {editing ? (
                            <input
                                type="text"
                                value={formData.sender_name || ''}
                                onChange={(e) => setFormData({ ...formData, sender_name: e.target.value })}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        ) : (
                            <p style={{ margin: 0, color: 'var(--text-muted)' }}>{letter.sender_name || '-'}</p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>Sender Address</label>
                        {editing ? (
                            <textarea
                                value={formData.sender_address || ''}
                                onChange={(e) => setFormData({ ...formData, sender_address: e.target.value })}
                                rows={3}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px',
                                    fontFamily: 'inherit'
                                }}
                            />
                        ) : (
                            <p style={{ margin: 0, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                                {letter.sender_address || '-'}
                            </p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>Received Date</label>
                        {editing ? (
                            <DatePicker
                                value={formData.received_date || ''}
                                onChange={(e) => setFormData({ ...formData, received_date: e.target.value })}
                            />
                        ) : (
                            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                                {letter.received_date ? new Date(letter.received_date).toLocaleDateString() : '-'}
                            </p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                            OCR Confidence: {letter.ocr_confidence ? `${letter.ocr_confidence.toFixed(0)}%` : 'N/A'}
                        </label>
                        <div style={{
                            width: '100%',
                            height: '8px',
                            background: 'var(--border)',
                            borderRadius: '4px',
                            overflow: 'hidden'
                        }}>
                            <div style={{
                                width: `${letter.ocr_confidence || 0}%`,
                                height: '100%',
                                background: letter.ocr_confidence > 80 ? '#10B981' : '#F59E0B',
                                transition: 'width 0.3s'
                            }} />
                        </div>
                    </div>
                </div>
            </div>

            {/* OCR Text */}
            <div style={{
                background: 'var(--surface)',
                padding: '1.5rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                marginTop: '2rem'
            }}>
                <h3 style={{ marginTop: 0 }}>Extracted Text (OCR)</h3>
                {editing ? (
                    <textarea
                        value={formData.ocr_text || ''}
                        onChange={(e) => setFormData({ ...formData, ocr_text: e.target.value })}
                        rows={15}
                        style={{
                            width: '100%',
                            padding: '1rem',
                            border: '1px solid var(--border)',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                            fontSize: '0.875rem'
                        }}
                    />
                ) : (
                    <pre style={{
                        background: 'var(--surface-2)',
                        padding: '1rem',
                        borderRadius: '4px',
                        border: '1px solid var(--border)',
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'monospace',
                        fontSize: '0.875rem',
                        maxHeight: '400px',
                        overflow: 'auto'
                    }}>
                        {letter.ocr_text || 'No OCR text available'}
                    </pre>
                )}
            </div>

            {/* Response Modal */}
            {showResponseModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-md" style={{ maxWidth: '600px', maxHeight: '80vh' }}>
                        <h2 className="app-modal-title">Create Response</h2>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>Subject</label>
                            <input
                                type="text"
                                value={responseData.subject}
                                onChange={(e) => setResponseData({ ...responseData, subject: e.target.value })}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>Recipient Name</label>
                            <input
                                type="text"
                                value={responseData.recipient_name}
                                onChange={(e) => setResponseData({ ...responseData, recipient_name: e.target.value })}
                                placeholder={letter.sender_name}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>Recipient Address</label>
                            <textarea
                                value={responseData.recipient_address}
                                onChange={(e) => setResponseData({ ...responseData, recipient_address: e.target.value })}
                                placeholder={letter.sender_address}
                                rows={3}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>Letter Content</label>
                            <textarea
                                value={responseData.content}
                                onChange={(e) => setResponseData({ ...responseData, content: e.target.value })}
                                rows={10}
                                style={{
                                    width: '100%',
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '4px'
                                }}
                            />
                        </div>

                        <div className="app-modal-actions">
                            <button
                                onClick={() => setShowResponseModal(false)}
                                className="btn btn-outline"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateResponse}
                                className="btn btn-success"
                            >
                                Create Response
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LetterDetailPage;

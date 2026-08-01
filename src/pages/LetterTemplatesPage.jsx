import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { formatDate } from '../utils/datetime';

const LetterTemplatesPage = () => {
    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState(null);
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        template_type: 'general',
        html_content: '',
        header_content: '',
        footer_content: ''
    });
    const { getToken } = useAuth();
    const dialog = useDialog();

    useEffect(() => {
        fetchTemplates();
    }, []);

    const fetchTemplates = async () => {
        try {
            const response = await fetch('/api/letters/templates', {
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });
            const data = await response.json();
            setTemplates(data);
        } catch (error) {
            console.error('Error fetching templates:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        try {
            const url = editingTemplate
                ? `/api/letters/templates/${editingTemplate.id}`
                : '/api/letters/templates';

            const response = await fetch(url, {
                method: editingTemplate ? 'PUT' : 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            if (response.ok) {
                await dialog.alert(`Template ${editingTemplate ? 'updated' : 'created'} successfully`);
                setShowModal(false);
                setEditingTemplate(null);
                setFormData({
                    name: '',
                    description: '',
                    template_type: 'general',
                    html_content: '',
                    header_content: '',
                    footer_content: ''
                });
                fetchTemplates();
            } else {
                await dialog.alert('Failed to save template');
            }
        } catch (error) {
            console.error('Save error:', error);
            await dialog.alert('Failed to save template');
        }
    };

    const handleEdit = (template) => {
        setEditingTemplate(template);
        setFormData({
            name: template.name,
            description: template.description || '',
            template_type: template.template_type || 'general',
            html_content: template.html_content,
            header_content: template.header_content || '',
            footer_content: template.footer_content || ''
        });
        setShowModal(true);
    };

    const handleDelete = async (id) => {
        const confirmed = await dialog.confirm('Are you sure you want to delete this template?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/letters/templates/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${getToken()}`, 'X-Device-ID': getDeviceId() }
            });

            if (response.ok) {
                await dialog.alert('Template deleted successfully');
                fetchTemplates();
            } else {
                await dialog.alert('Failed to delete template');
            }
        } catch (error) {
            console.error('Delete error:', error);
            await dialog.alert('Failed to delete template');
        }
    };

    const insertVariable = (variable) => {
        const textarea = document.getElementById('html_content');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = formData.html_content;
        const before = text.substring(0, start);
        const after = text.substring(end);

        setFormData({
            ...formData,
            html_content: before + `{{${variable}}}` + after
        });
    };

    const commonVariables = [
        { label: 'Current Date', value: 'current_date' },
        { label: 'Letter Number', value: 'letter_number' },
        { label: 'User Name', value: 'user.name' },
        { label: 'Customer Name', value: 'customer.name' },
        { label: 'Customer Address', value: 'customer.address' },
        { label: 'Project Name', value: 'project.name' },
        { label: 'Project Code', value: 'project.code' },
        { label: 'Sender Name', value: 'sender.name' },
        { label: 'Sender Address', value: 'sender.address' }
    ];

    return (
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{
                background: '#0066CC',
                color: 'white',
                padding: '1.5rem 2rem',
                borderRadius: '8px',
                marginBottom: '2rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>
                        Letter Templates
                    </h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.95, color: 'white' }}>
                        Create and manage reusable letter templates with dynamic variables
                    </p>
                </div>
                <button
                    onClick={() => {
                        setEditingTemplate(null);
                        setFormData({
                            name: '',
                            description: '',
                            template_type: 'general',
                            html_content: '',
                            header_content: '',
                            footer_content: ''
                        });
                        setShowModal(true);
                    }}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: '#10B981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '1rem'
                    }}
                >
                    + Create Template
                </button>
            </div>

            {/* Templates Grid */}
            {loading ? (
                <div style={{ padding: '3rem', textAlign: 'center' }}>
                    <p>Loading templates...</p>
                </div>
            ) : templates.length === 0 ? (
                <div style={{
                    background: 'var(--surface)',
                    padding: '3rem',
                    borderRadius: '8px',
                    textAlign: 'center',
                    color: 'var(--text-faint)'
                }}>
                    <p style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>
                        No templates found
                    </p>
                    <p>Create your first template to get started</p>
                </div>
            ) : (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
                    gap: '1.5rem'
                }}>
                    {templates.map((template) => (
                        <div
                            key={template.id}
                            style={{
                                background: 'var(--surface)',
                                borderRadius: '8px',
                                padding: '1.5rem',
                                border: '1px solid var(--border)',
                                transition: 'all 0.2s',
                                cursor: 'pointer'
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.boxShadow = 'none';

                            }}
                        >
                            <div style={{ marginBottom: '1rem' }}>
                                <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-strong)' }}>
                                    {template.name}
                                </h3>
                                <span style={{
                                    display: 'inline-block',
                                    marginTop: '0.5rem',
                                    padding: '0.25rem 0.75rem',
                                    background: 'var(--surface-3)',
                                    borderRadius: '12px',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    color: 'var(--text-muted)',
                                    textTransform: 'capitalize'
                                }}>
                                    {template.template_type}
                                </span>
                            </div>

                            <p style={{
                                color: 'var(--text-muted)',
                                fontSize: '0.875rem',
                                marginBottom: '1rem',
                                minHeight: '3rem'
                            }}>
                                {template.description || 'No description'}
                            </p>

                            <div style={{
                                fontSize: '0.75rem',
                                color: 'var(--text-faint)',
                                marginBottom: '1rem'
                            }}>
                                Created by {template.created_by_name || 'Unknown'} on{' '}
                                {formatDate(template.created_at)}
                            </div>

                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button
                                    onClick={() => handleEdit(template)}
                                    style={{
                                        flex: 1,
                                        padding: '0.5rem 1rem',
                                        background: '#0066CC',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                        fontSize: '0.875rem'
                                    }}
                                >
                                    Edit
                                </button>
                                <button
                                    onClick={() => handleDelete(template.id)}
                                    style={{
                                        flex: 1,
                                        padding: '0.5rem 1rem',
                                        background: '#EF4444',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                        fontSize: '0.875rem'
                                    }}
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Template Modal */}
            {showModal && (
                <div className="app-modal-backdrop" style={{ padding: '2rem' }}>
                    <div className="app-modal app-modal-lg" style={{ maxWidth: '900px' }}>
                        <h2 className="app-modal-title">
                            {editingTemplate ? 'Edit Template' : 'Create Template'}
                        </h2>

                        <form onSubmit={handleSubmit}>
                            <div style={{ marginBottom: '1rem' }}>
                                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    Template Name *
                                </label>
                                <input
                                    type="text"
                                    required
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '1rem'
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: '1rem' }}>
                                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    Description
                                </label>
                                <textarea
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    rows={2}
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '1rem',
                                        fontFamily: 'inherit'
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: '1rem' }}>
                                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    Template Type
                                </label>
                                <select
                                    value={formData.template_type}
                                    onChange={(e) => setFormData({ ...formData, template_type: e.target.value })}
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '1rem',
                                        background: 'var(--surface)'
                                    }}
                                >
                                    <option value="general">General</option>
                                    <option value="project">Project</option>
                                    <option value="milestone">Milestone</option>
                                    <option value="response">Response</option>
                                </select>
                            </div>

                            <div style={{ marginBottom: '1rem' }}>
                                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    Header Content
                                </label>
                                <textarea
                                    value={formData.header_content}
                                    onChange={(e) => setFormData({ ...formData, header_content: e.target.value })}
                                    rows={3}
                                    placeholder="Company letterhead, logo, etc."
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '0.875rem',
                                        fontFamily: 'monospace'
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: '1rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                    <label style={{ fontWeight: 600 }}>
                                        Letter Content * (HTML)
                                    </label>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        Insert variables:
                                        {commonVariables.slice(0, 4).map((v) => (
                                            <button
                                                key={v.value}
                                                type="button"
                                                onClick={() => insertVariable(v.value)}
                                                style={{
                                                    marginLeft: '0.5rem',
                                                    padding: '0.25rem 0.5rem',
                                                    background: 'var(--surface-3)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: '4px',
                                                    cursor: 'pointer',
                                                    fontSize: '0.75rem'
                                                }}
                                            >
                                                {v.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <textarea
                                    id="html_content"
                                    required
                                    value={formData.html_content}
                                    onChange={(e) => setFormData({ ...formData, html_content: e.target.value })}
                                    rows={12}
                                    placeholder="Enter letter content. Use {{variable_name}} for dynamic data."
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '0.875rem',
                                        fontFamily: 'monospace'
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: '1.5rem' }}>
                                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    Footer Content
                                </label>
                                <textarea
                                    value={formData.footer_content}
                                    onChange={(e) => setFormData({ ...formData, footer_content: e.target.value })}
                                    rows={2}
                                    placeholder="Company contact info, signature block, etc."
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: '6px',
                                        fontSize: '0.875rem',
                                        fontFamily: 'monospace'
                                    }}
                                />
                            </div>

                            <div className="app-modal-actions">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowModal(false);
                                        setEditingTemplate(null);
                                    }}
                                    className="btn btn-outline"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                >
                                    {editingTemplate ? 'Update Template' : 'Create Template'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LetterTemplatesPage;

import React, { useState, useEffect } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { useNavigate } from 'react-router-dom';

const ProjectManagementPage = () => {
    const [projects, setProjects] = useState([]);
    const [customers, setCustomers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState({
        project_code: '',
        project_name: '',
        customer_id: '',
        contract_number: '',
        contract_date: '',
        contract_value: '',
        start_date: '',
        end_date: '',
        status: 'active'
    });
    const [editingId, setEditingId] = useState(null);
    const { getToken } = useAuth();
    const navigate = useNavigate();
    const dialog = useDialog();

    useEffect(() => {
        fetchProjects();
        fetchCustomers();
    }, [searchTerm]);

    const fetchProjects = async () => {
        try {
            const url = searchTerm
                ? `/api/projects?search=${encodeURIComponent(searchTerm)}`
                : '/api/projects';

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                }
            });
            const data = await response.json();
            setProjects(data.projects || []);
        } catch (error) {
            console.error('Error fetching projects:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchCustomers = async () => {
        try {
            const response = await fetch('/api/customers', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                }
            });
            const data = await response.json();
            setCustomers(data.customers || []);
        } catch (error) {
            console.error('Error fetching customers:', error);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        const url = editingId ? `/api/projects/${editingId}` : '/api/projects';
        const method = editingId ? 'PUT' : 'POST';

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                },
                body: JSON.stringify(formData)
            });

            if (response.ok) {
                await dialog.alert(editingId ? 'Project updated!' : 'Project created!');
                setShowModal(false);
                resetForm();
                fetchProjects();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to save project');
            }
        } catch (error) {
            console.error('Error saving project:', error);
            await dialog.alert('Failed to save project');
        }
    };

    const resetForm = () => {
        setFormData({
            project_code: '',
            project_name: '',
            customer_id: '',
            contract_number: '',
            contract_date: '',
            contract_value: '',
            start_date: '',
            end_date: '',
            status: 'active'
        });
        setEditingId(null);
    };

    const handleEdit = (project) => {
        setFormData({
            project_code: project.project_code,
            project_name: project.project_name,
            customer_id: project.customer_id,
            contract_number: project.contract_number || '',
            contract_date: project.contract_date || '',
            contract_value: project.contract_value || '',
            start_date: project.start_date || '',
            end_date: project.end_date || '',
            status: project.status
        });
        setEditingId(project.id);
        setShowModal(true);
    };

    const handleDelete = async (projectId) => {
        const confirmed = await dialog.confirm('Are you sure you want to delete this project?');
        if (!confirmed) return;

        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId()
                }
            });

            if (response.ok) {
                await dialog.alert('Project deleted');
                fetchProjects();
            } else {
                const data = await response.json();
                await dialog.alert(data.error || 'Failed to delete project');
            }
        } catch (error) {
            console.error('Error deleting project:', error);
            await dialog.alert('Failed to delete project');
        }
    };

    const getStatusBadge = (status) => {
        const styles = {
            active: { background: '#10B981', color: 'white' },
            completed: { background: '#3B82F6', color: 'white' },
            'on-hold': { background: '#F59E0B', color: 'white' }
        };
        return (
            <span style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '12px',
                fontSize: '0.75rem',
                fontWeight: 600,
                ...(styles[status] || styles.active)
            }}>
                {status?.toUpperCase()}
            </span>
        );
    };

    if (loading) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading projects...</div>;
    }

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
                <h1 style={{ margin: 0, fontSize: '1.75rem', color: 'white' }}>Project Management</h1>
                <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, color: 'white' }}>
                    Manage projects and contracts linked to customers
                </p>
            </div>

            {/* Actions Bar */}
            <div style={{
                background: 'white',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                padding: '1.5rem',
                marginBottom: '1.5rem',
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center'
            }}>
                <div style={{ flex: 1, minWidth: '250px' }}>
                    <input
                        type="text"
                        placeholder="Search projects..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            border: '1px solid #D1D5DB',
                            borderRadius: '6px',
                            fontSize: '1rem'
                        }}
                    />
                </div>

                <button
                    onClick={() => {
                        setShowModal(true);
                        resetForm();
                    }}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: '#7C3AED',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 600
                    }}
                >
                    + New Project
                </button>
            </div>

            {/* Projects Table */}
            <div style={{
                background: 'white',
                border: '1px solid #E0E0E0',
                borderRadius: '8px',
                overflow: 'hidden'
            }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#F9FAFB' }}>
                            <tr>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Project Code</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Project Name</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Customer</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Contract #</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Value</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Status</th>
                                <th style={{ padding: '1rem', textAlign: 'left', borderBottom: '1px solid #E5E7EB' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {projects.length === 0 ? (
                                <tr>
                                    <td colSpan="7" style={{ textAlign: 'center', padding: '3rem', color: '#999' }}>
                                        No projects found. Create your first project.
                                    </td>
                                </tr>
                            ) : (
                                projects.map(project => (
                                    <tr key={project.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                                        <td style={{ padding: '1rem', fontFamily: 'monospace', color: '#7C3AED', fontWeight: 600 }}>
                                            {project.project_code}
                                        </td>
                                        <td style={{ padding: '1rem', fontWeight: 600 }}>{project.project_name}</td>
                                        <td style={{ padding: '1rem' }}>
                                            <div>{project.customer_name}</div>
                                            <div style={{ fontSize: '0.75rem', color: '#666' }}>{project.customer_code}</div>
                                        </td>
                                        <td style={{ padding: '1rem' }}>{project.contract_number || '-'}</td>
                                        <td style={{ padding: '1rem' }}>
                                            {project.contract_value ? `₹${parseFloat(project.contract_value).toLocaleString()}` : '-'}
                                        </td>
                                        <td style={{ padding: '1rem' }}>{getStatusBadge(project.status)}</td>
                                        <td style={{ padding: '1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button
                                                    onClick={() => handleEdit(project)}
                                                    style={{
                                                        padding: '0.375rem 0.75rem',
                                                        background: '#3B82F6',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer',
                                                        fontSize: '0.875rem'
                                                    }}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(project.id)}
                                                    style={{
                                                        padding: '0.375rem 0.75rem',
                                                        background: '#EF4444',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer',
                                                        fontSize: '0.875rem'
                                                    }}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Add/Edit Project Modal */}
            {showModal && (
                <div className="app-modal-backdrop">
                    <div className="app-modal app-modal-md" style={{ maxWidth: '700px' }}>
                        <h2 className="app-modal-title">{editingId ? 'Edit Project' : 'Create New Project'}</h2>
                        <form onSubmit={handleSubmit}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                {/* Project Code */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Project Code *
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.project_code}
                                        onChange={(e) => setFormData({ ...formData, project_code: e.target.value })}
                                        required
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* Customer */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Customer *
                                    </label>
                                    <select
                                        value={formData.customer_id}
                                        onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                                        required
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    >
                                        <option value="">Select Customer</option>
                                        {customers.map(customer => (
                                            <option key={customer.id} value={customer.id}>
                                                {customer.customer_name} ({customer.customer_code})
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Project Name - Full Width */}
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Project Name *
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.project_name}
                                        onChange={(e) => setFormData({ ...formData, project_name: e.target.value })}
                                        required
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* Contract Number */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Contract Number
                                    </label>
                                    <input
                                        type="text"
                                        value={formData.contract_number}
                                        onChange={(e) => setFormData({ ...formData, contract_number: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* Contract Date */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Contract Date
                                    </label>
                                    <input
                                        type="date"
                                        value={formData.contract_date}
                                        onChange={(e) => setFormData({ ...formData, contract_date: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* Contract Value */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Contract Value (₹)
                                    </label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={formData.contract_value}
                                        onChange={(e) => setFormData({ ...formData, contract_value: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* Status */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Status
                                    </label>
                                    <select
                                        value={formData.status}
                                        onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    >
                                        <option value="active">Active</option>
                                        <option value="completed">Completed</option>
                                        <option value="on-hold">On Hold</option>
                                    </select>
                                </div>

                                {/* Start Date */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        Start Date
                                    </label>
                                    <input
                                        type="date"
                                        value={formData.start_date}
                                        onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>

                                {/* End Date */}
                                <div>
                                    <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        End Date
                                    </label>
                                    <input
                                        type="date"
                                        value={formData.end_date}
                                        onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                                        style={{ width: '100%', padding: '0.5rem', border: '1px solid #D1D5DB', borderRadius: '4px' }}
                                    />
                                </div>
                            </div>

                            <div className="app-modal-actions">
                                <button type="submit" className="btn btn-primary">
                                    {editingId ? 'Update Project' : 'Create Project'}
                                </button>
                                <button type="button" className="btn btn-outline" onClick={() => {
                                    setShowModal(false);
                                    resetForm();
                                }}>
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ProjectManagementPage;

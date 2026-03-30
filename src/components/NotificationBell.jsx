import React, { useState, useEffect, useRef } from 'react';
import { useAuth, getDeviceId } from '../contexts/AuthContext';

const NotificationBell = () => {
    const [notifications, setNotifications] = useState([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const { getToken } = useAuth();
    const dropdownRef = useRef(null);

    useEffect(() => {
        fetchNotifications();
        const interval = setInterval(fetchNotifications, 10000); // Poll every 10 seconds
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setShowDropdown(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchNotifications = async () => {
        try {
            const response = await fetch('/api/jcc/notifications', {
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            const data = await response.json();
            if (Array.isArray(data)) {
                setNotifications(data);
                setUnreadCount(data.filter(n => n.read === 0).length);
            } else {
                console.warn('Expected array for notifications, got:', data);
                setNotifications([]);
                setUnreadCount(0);
            }
        } catch (error) {
            console.error('Error fetching notifications:', error);
        }
    };

    const markAsRead = async (notificationId) => {
        try {
            await fetch(`/api/jcc/notifications/${notificationId}/read`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            fetchNotifications();
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    };

    const markAllAsRead = async () => {
        try {
            await fetch('/api/jcc/notifications/read-all', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getToken()}`,
                    'X-Device-ID': getDeviceId(),
                },
            });
            fetchNotifications();
        } catch (error) {
            console.error('Error marking all as read:', error);
        }
    };

    const getNotificationColor = (type) => {
        switch (type) {
            case 'success': return '#10B981';
            case 'error': return '#EF4444';
            case 'warning': return '#F59E0B';
            default: return '#0066CC';
        }
    };

    return (
        <div style={{ position: 'relative' }} ref={dropdownRef}>
            <button
                onClick={() => setShowDropdown(!showDropdown)}
                style={{
                    position: 'relative',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '8px',
                    color: '#64748b',
                    transition: 'color 0.2s'
                }}
                onMouseEnter={e => e.target.style.color = '#3b82f6'}
                onMouseLeave={e => e.target.style.color = '#64748b'}
            >
                {/* Bell Icon */}
                <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>

                {/* Unread Badge */}
                {unreadCount > 0 && (
                    <span style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        background: '#EF4444',
                        color: 'white',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        fontWeight: 'bold'
                    }}>
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {/* Dropdown */}
            {showDropdown && (
                <div style={{
                    position: 'absolute',
                    top: 'calc(100% + 10px)',
                    right: 0,
                    width: '380px',
                    maxHeight: '500px',
                    background: 'rgba(255, 255, 255, 0.95)',
                    backdropFilter: 'blur(12px)',
                    borderRadius: '16px',
                    boxShadow: '0 10px 40px -10px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255,255,255,0.5) inset',
                    overflow: 'hidden',
                    zIndex: 1000,
                    border: '1px solid rgba(226, 232, 240, 0.8)'
                }}>
                    {/* Header */}
                    <div style={{
                        padding: '16px 20px',
                        borderBottom: '1px solid rgba(0,0,0,0.05)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: 'rgba(248, 250, 252, 0.5)'
                    }}>
                        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#1e293b' }}>Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={markAllAsRead}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#3b82f6',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    padding: '4px 8px',
                                    borderRadius: '6px',
                                    transition: 'background 0.2s'
                                }}
                                onMouseEnter={e => e.target.style.background = 'rgba(59, 130, 246, 0.1)'}
                                onMouseLeave={e => e.target.style.background = 'transparent'}
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    {/* Notifications List */}
                    <div style={{ maxHeight: '400px', overflowY: 'auto' }} className="custom-scrollbar">
                        {notifications.length === 0 ? (
                            <div style={{
                                padding: '60px 20px',
                                textAlign: 'center',
                                color: '#94a3b8'
                            }}>
                                <svg style={{ width: '48px', height: '48px', margin: '0 auto 16px', opacity: 0.5 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                                <p style={{ margin: 0, fontWeight: 500 }}>No new notifications</p>
                            </div>
                        ) : (
                            notifications.map((notification) => (
                                <div
                                    key={notification.id}
                                    onClick={() => !notification.read && markAsRead(notification.id)}
                                    style={{
                                        padding: '16px 20px',
                                        borderBottom: '1px solid rgba(0,0,0,0.03)',
                                        cursor: notification.read ? 'default' : 'pointer',
                                        background: notification.read ? 'transparent' : 'rgba(59, 130, 246, 0.04)',
                                        transition: 'all 0.2s ease',
                                        position: 'relative'
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!notification.read) e.currentTarget.style.background = 'rgba(59, 130, 246, 0.08)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = notification.read ? 'transparent' : 'rgba(59, 130, 246, 0.04)';
                                    }}
                                >
                                    <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                                        <div style={{
                                            width: '8px',
                                            height: '8px',
                                            borderRadius: '50%',
                                            background: getNotificationColor(notification.type),
                                            marginTop: '8px',
                                            flexShrink: 0,
                                            boxShadow: `0 0 0 4px ${getNotificationColor(notification.type)}20`
                                        }}></div>
                                        <div style={{ flex: 1 }}>
                                            <p style={{
                                                margin: '0 0 4px 0',
                                                fontWeight: 600,
                                                fontSize: '14px',
                                                color: '#1e293b',
                                                fontFamily: 'inherit'
                                            }}>
                                                {notification.title}
                                            </p>
                                            <p style={{
                                                margin: '0 0 8px 0',
                                                fontSize: '13px',
                                                color: '#64748b',
                                                lineHeight: '1.5'
                                            }}>
                                                {notification.message}
                                            </p>
                                            <p style={{
                                                margin: 0,
                                                fontSize: '11px',
                                                color: '#94a3b8',
                                                fontWeight: 500
                                            }}>
                                                {new Date(notification.created_at).toLocaleString(undefined, {
                                                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                                                })}
                                            </p>
                                        </div>
                                        {!notification.read && (
                                            <div style={{
                                                width: '8px',
                                                height: '8px',
                                                borderRadius: '50%',
                                                background: '#3b82f6',
                                                marginTop: '6px',
                                                flexShrink: 0
                                            }}></div>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default NotificationBell;

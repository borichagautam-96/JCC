import { Client } from 'ldapts';
import { env } from '../config/env.js';

const escapeLdapFilterValue = (value) => {
    const input = String(value || '');
    let escaped = '';

    for (const char of input) {
        switch (char) {
            case '\\':
                escaped += String.raw`\5c`;
                break;
            case '*':
                escaped += String.raw`\2a`;
                break;
            case '(':
                escaped += String.raw`\28`;
                break;
            case ')':
                escaped += String.raw`\29`;
                break;
            default:
                if (char.codePointAt(0) === 0) {
                    escaped += String.raw`\00`;
                } else {
                    escaped += char;
                }
                break;
        }
    }

    return escaped;
};

const toNonEmptyString = (value) => {
    if (typeof value !== 'string') {
        return '';
    }
    const trimmed = value.trim();
    return trimmed || '';
};

const getEntryValue = (entry, key) => {
    if (!entry || typeof entry !== 'object') {
        return '';
    }

    const value = entry[key];
    if (Array.isArray(value)) {
        const found = value.find((item) => typeof item === 'string' && item.trim());
        return found ? found.trim() : '';
    }

    if (typeof value === 'string') {
        return value.trim();
    }

    return '';
};

const getEntryValueByKeys = (entry, keys = []) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(keys) || keys.length === 0) {
        return '';
    }

    // Try direct matches first.
    for (const key of keys) {
        const value = getEntryValue(entry, key);
        if (value) {
            return value;
        }
    }

    // Then try case-insensitive matches from entry keys.
    const entryKeys = Object.keys(entry);
    for (const key of keys) {
        const foundKey = entryKeys.find((entryKey) => entryKey.toLowerCase() === String(key).toLowerCase());
        if (!foundKey) {
            continue;
        }

        const value = getEntryValue(entry, foundKey);
        if (value) {
            return value;
        }
    }

    return '';
};

const buildBindUser = (username, domain) => {
    const trimmedUsername = String(username || '').trim();
    const effectiveDomain = toNonEmptyString(domain) || toNonEmptyString(env.ldapDomain);
    const bindTemplate = toNonEmptyString(env.ldapBindTemplate);

    if (bindTemplate) {
        return bindTemplate
            .split('{{username}}').join(trimmedUsername)
            .split('{{domain}}').join(effectiveDomain);
    }

    if (trimmedUsername.includes('@') || trimmedUsername.includes('\\')) {
        return trimmedUsername;
    }

    if (effectiveDomain) {
        return `${trimmedUsername}@${effectiveDomain}`;
    }

    return trimmedUsername;
};

const buildSearchFilter = (username) => {
    const template = toNonEmptyString(env.ldapSearchFilterTemplate) || '({{userAttribute}}={{username}})';
    const userAttribute = toNonEmptyString(env.ldapUserAttribute) || 'sAMAccountName';
    const safeUsername = escapeLdapFilterValue(username);

    return template
        .split('{{userAttribute}}').join(userAttribute)
        .split('{{username}}').join(safeUsername);
};

const discoverBaseDn = async (client) => {
    try {
        const { searchEntries } = await client.search('', {
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: ['defaultNamingContext', 'namingContexts'],
        });

        if (!Array.isArray(searchEntries) || searchEntries.length === 0) {
            return '';
        }

        const rootDse = searchEntries[0];
        const defaultNamingContext = getEntryValue(rootDse, 'defaultNamingContext');
        if (defaultNamingContext) {
            return defaultNamingContext;
        }

        const namingContexts = rootDse?.namingContexts;
        if (Array.isArray(namingContexts)) {
            const firstNamingContext = namingContexts.find((item) => typeof item === 'string' && item.trim());
            return firstNamingContext ? firstNamingContext.trim() : '';
        }

        if (typeof namingContexts === 'string' && namingContexts.trim()) {
            return namingContexts.trim();
        }
    } catch (error) {
        console.warn('LDAP base DN discovery failed:', error?.message || error);
        return '';
    }

    return '';
};

const mapLdapErrorCode = (error) => {
    const message = String(error?.message || '').toLowerCase();

    if (
        message.includes('data 525')
        || message.includes('user not found')
        || message.includes('no such user')
    ) {
        return 'USER_NOT_FOUND';
    }

    if (
        message.includes('invalid credentials')
        || message.includes('invalidcredentials')
        || message.includes('acceptsecuritycontext')
        || message.includes('data 52e')
    ) {
        return 'INVALID_CREDENTIALS';
    }

    if (message.includes('no such object') || message.includes('invalid dn syntax')) {
        return 'CONFIG_ERROR';
    }

    if (
        message.includes('connect')
        || message.includes('timeout')
        || message.includes('socket')
        || message.includes('econn')
        || message.includes('unavailable')
    ) {
        return 'SERVER_ERROR';
    }

    return 'SERVER_ERROR';
};

const normalizeProfile = (entry, username) => {
    const firstName = getEntryValueByKeys(entry, ['givenName', 'firstname', 'firstName']);
    const surname = getEntryValueByKeys(entry, ['sn', 'surname', 'lastName', 'lastname']);

    const combinedName = [firstName, surname].filter(Boolean).join(' ').trim();
    const displayName = getEntryValueByKeys(entry, ['displayName']);
    const commonName = getEntryValueByKeys(entry, ['cn']);
    const directoryName = getEntryValueByKeys(entry, ['name']);
    const mail = getEntryValueByKeys(entry, ['mail']);
    const principalName = getEntryValueByKeys(entry, ['userPrincipalName']);

    return {
        username: String(username || '').trim(),
        fullName: combinedName || displayName || commonName || directoryName || String(username || '').trim(),
        firstName: firstName || null,
        surname: surname || null,
        email: mail || null,
        principalName: principalName || null,
    };
};

export const authenticateWithLdap = async ({ username, password, domain } = {}) => {
    const trimmedUsername = String(username || '').trim();
    const rawPassword = typeof password === 'string' ? password : '';

    if (!trimmedUsername || !rawPassword) {
        return {
            authenticated: false,
            errorCode: 'INVALID_CREDENTIALS',
            message: 'Username and password are required for LDAP authentication.',
        };
    }

    const client = new Client({
        url: env.ldapUrl,
        timeout: env.ldapTimeoutMs,
        connectTimeout: env.ldapConnectTimeoutMs,
    });

    try {
        const bindUser = buildBindUser(trimmedUsername, domain);
        await client.bind(bindUser, rawPassword);

        const baseDn = toNonEmptyString(env.ldapBaseDn) || await discoverBaseDn(client);
        if (!baseDn) {
            return {
                authenticated: false,
                errorCode: 'CONFIG_ERROR',
                message: 'LDAP base DN could not be determined. Set LDAP_BASE_DN in environment.',
            };
        }

        const filter = buildSearchFilter(trimmedUsername);
        const { searchEntries } = await client.search(baseDn, {
            scope: 'sub',
            filter,
            attributes: ['cn', 'displayName', 'mail', 'name', 'userPrincipalName', 'givenName', 'sn', 'surname'],
        });

        const entry = Array.isArray(searchEntries) && searchEntries.length > 0 ? searchEntries[0] : null;

        return {
            authenticated: true,
            profile: normalizeProfile(entry, trimmedUsername),
            baseDn,
        };
    } catch (error) {
        return {
            authenticated: false,
            errorCode: mapLdapErrorCode(error),
            message: String(error?.message || 'LDAP authentication failed.'),
        };
    } finally {
        try {
            await client.unbind();
        } catch (error) {
            console.warn('LDAP unbind cleanup failed:', error?.message || error);
        }
    }
};

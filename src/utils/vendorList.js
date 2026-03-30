const BASE_VENDOR_NAMES = [
    'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
    'Armoured Vehicles Nigam Limited',
    'Asha Furniture Works',
    'Balaji Arts',
    'Bharat Electronics Limited',
    'CHANDRAHAS SHETTY',
    'DDSPLM Pvt. Ltd.',
    'Delos Consulting Pvt. Ltd.',
    'DesignTech Systems Pvt. Ltd.',
    'GenieHR Solutions Pvt. Ltd.',
    'Global Publishing Solutions Ltd.',
    'Hornbill Studios Pvt Ltd',
    'JUSTVFX STUDIOS',
    'LOUISCIAGA OVERSEAS PVT. LTD',
    'MICROPOINT COMPUTERS PRIVATE LIMITED',
    'Pentagon System And Services Pvt. Ltd',
    'PEREVODRU',
    'PEREVODRU GLOBAL TRANSLATION SERVICES',
    'Pixlar Art Creation',
    'RAC IT SOLUTIONS PVT. LTD.',
    'Schneider Electric India Pvt. Limited (SEIPL)',
    'Shezarweb Technologies',
    'Shivam Computers',
    'SIEMENS INDUSTRY SOFTWARE (INDIA)',
    'Smartify Software Solutions LLP',
    'Somshanti Enterprises',
    'Urgent Courier',
    'Voice Kraft Productions',
    'White Globe Pvt. Ltd.',
    'Track On Courier'
];

const CUSTOM_VENDOR_STORAGE_KEY = 'custom_vendor_names';
export const ADD_NEW_VENDOR_OPTION = '__ADD_NEW_VENDOR__';

const normalize = (name) => (name || '').trim();

const getCustomVendorNames = () => {
    try {
        const raw = localStorage.getItem(CUSTOM_VENDOR_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalize).filter(Boolean);
    } catch {
        return [];
    }
};

const setCustomVendorNames = (names) => {
    try {
        localStorage.setItem(CUSTOM_VENDOR_STORAGE_KEY, JSON.stringify(names));
    } catch {
        // Ignore storage write failures.
    }
};

export const getVendorNames = (selectedVendor = '') => {
    const selected = normalize(selectedVendor);
    const customVendors = getCustomVendorNames();
    const merged = [...BASE_VENDOR_NAMES, ...customVendors];

    if (selected && !merged.some((v) => v.toLowerCase() === selected.toLowerCase())) {
        return [selected, ...merged];
    }

    return merged;
};

export const addCustomVendorName = (vendorName) => {
    const normalizedName = normalize(vendorName);
    if (!normalizedName) {
        return { added: false, reason: 'empty' };
    }

    const existing = getVendorNames();
    const exists = existing.some((v) => v.toLowerCase() === normalizedName.toLowerCase());
    if (exists) {
        return { added: false, reason: 'exists', value: existing.find((v) => v.toLowerCase() === normalizedName.toLowerCase()) };
    }

    const currentCustom = getCustomVendorNames();
    const nextCustom = [...currentCustom, normalizedName];
    setCustomVendorNames(nextCustom);
    return { added: true, value: normalizedName };
};

export const VENDOR_NAMES = BASE_VENDOR_NAMES;

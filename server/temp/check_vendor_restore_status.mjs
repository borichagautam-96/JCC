import db from '../database.js';

const names = [
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

const normalize = (value) => String(value || '').trim().toLowerCase();
const existingRows = db.prepare('SELECT vendor_name FROM vendors').all();
const existingNames = new Set(existingRows.map((row) => normalize(row.vendor_name)));

const missing = names.filter((name) => !existingNames.has(normalize(name)));
console.log(JSON.stringify({
  requested: names.length,
  existing: names.length - missing.length,
  missingCount: missing.length,
  missing,
}, null, 2));

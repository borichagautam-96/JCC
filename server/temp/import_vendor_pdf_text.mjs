import db from '../database.js';

const RAW_ENTRIES = [
  {
    vendorName: 'ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD',
    vendorCode: 'ALLW003',
    address: '9-C/10Vertex Vikas Shopping Centre, Andheri (East)Near Railway Station',
  },
  {
    vendorName: 'Armoured Vehicles Nigam Limited',
    vendorCode: 'ARMO001',
    address: 'Bhaktavatasalapuram, Armoured Vehicle Headquarters, Avadi Ch HVF Road, Avadi Tamil nadu',
  },
  {
    vendorName: 'Asha Furniture Works',
    vendorCode: 'ASHA011',
    address: 'Seva Sangh, G.B.B.S.D, Gandhi Nagar, Tekadi, Cut No. 10, Kur163, Ganga Yamuna RahivashiMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Balaji Arts',
    vendorCode: 'BALA029',
    address: 'Roshan Chanda Niwas,39,Aundh Road,Kamble Vasti,AmbedkarnagarAundh RoadPACHORA MAHARASHTRA',
  },
  {
    vendorName: 'Bharat Electronics Limited',
    vendorCode: 'BHAR002',
    address: 'BHARAT ELECTRONICS LIMITEDBHARAT NAGARGHAZIABAD UTTAR PRADESHINDIA 201010',
  },
  {
    vendorName: 'Chandrahas J Shetty',
    vendorCode: 'CHAN027',
    address: '203/20 Kunj Niwas, Sahakar Road, Jogeshwari West3Sahakar RoadMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'DDSPLM Pvt. Ltd.',
    vendorCode: 'DDSP001',
    address: 'SF 6436th Floor, JMD Megapolis SohnaSector 48,GURGAON HARYANA',
  },
  {
    vendorName: 'Delos Consulting Pvt. Ltd.',
    vendorCode: 'DELO004',
    address: 'F1117Office One,Survey No 5, Mahadevapura PostITPL Main Road, Hoodi CircleBANGALORE KARNATAKA',
  },
  {
    vendorName: 'DesignTech Systems Pvt. Ltd.',
    vendorCode: 'DESI003',
    address: 'BHUGAON, TAL. MULSHI, DIST. PUSHOP NO. 02, DYANANDA POSTPUNE MAHARASHTRA',
  },
  {
    vendorName: 'GenieHR Solutions Pvt. Ltd.',
    vendorCode: 'GENI004',
    address: 'WA 121/20Rohini Complex, Shakhapur, Laxminagar, East DelhiGr-DELHI DELHI',
  },
  {
    vendorName: 'Global Publishing Solutions Ltd.',
    vendorCode: 'GLOB072',
    address: 'WORKSHED5DG,LONDON STREET, UKSWINDON ENGLAND',
  },
  {
    vendorName: 'Hornbill Studios Pvt Ltd',
    vendorCode: 'HORN002',
    address: '1-95/5/1251-95/5/125 126, , PATRIKA NAGARMADHAPURHYDERABAD TELANGANA',
  },
  {
    vendorName: 'JUSTVFX STUDIOS',
    vendorCode: 'JUST003',
    address: '202Plot No. 525 and 526 Ayyappa Society Madhapur Hyderabad TR Hub BuildingHYDERABAD TELANGANA',
  },
  {
    vendorName: 'LOUISCIAGA OVERSEAS PVT. LTD',
    vendorCode: 'LOUI001',
    address: 'LOUIS CIAGA OVERSEAS PRIVATE LIMITEDD 65WAZIRABAD,BURARI, NORTH DELHI3STREET NO-9',
  },
  {
    vendorName: 'MICROPOINT COMPUTERS PRIVATE LIMITED',
    vendorCode: 'MICR005',
    address: 'MAHAKALI CAVES ROAD , ANDHERIINDUSTRIAL UNIT NO.17-18 , GRMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Pentagon System And Services Pvt. Ltd',
    vendorCode: 'PENT001',
    address: 'KORAMANGALABANGALORE431, 1ST FLOOR 8TH MAIN ROADBENGALURU KARNATAKA',
  },
  {
    vendorName: 'PEREVODRU',
    vendorCode: 'PERE001',
    address: '',
  },
  {
    vendorName: 'PEREVODRU GLOBAL TRANSLATION SERVICES',
    vendorCode: 'PERE001',
    address: 'B-2304B-2304, RAJ GRANDEUR, BEHIND HIRANANDNI HOSPITAL, POWABEHIND HIRANANDNI HOSPITALMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Pixlar Art Creation',
    vendorCode: 'PIXL001',
    address: 'Opp. Century Bazar Dr. Annie,Besant Road, WorliUnit no.8 Manjrekar sadan bldgMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'RAC IT SOLUTIONS PVT. LTD.',
    vendorCode: 'RACI001',
    address: 'SNo 209 4RAC House Goodwill Enclave3 17Road No 9A Kalyani NagarPUNE MAHARASHTRA',
  },
  {
    vendorName: 'Schneider Electric India Pvt. Limited (SEIPL)',
    vendorCode: 'SCHN002',
    address: 'A-600,TTC Industrial Area, E&A Campus, Shill Mahape Road,NAVControl & Automation UnitNAVI MUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Shezarweb Technologies',
    vendorCode: 'SHEZ001',
    address: '203203 Shreya House 301/A Pereira Hill Road, Andheri (East)301/A Pereira Hill Road,MUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Shivam Computers',
    vendorCode: 'SHIV066',
    address: 'G2G 2, Nansi Munsi Chawl, Sakivihar Road, Sakinaka Kurla KamSakinaka Kurla Kamani Oil MillMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'SIEMENS INDUSTRY SOFTWARE (INDIA)',
    vendorCode: 'SIEM005',
    address: 'HINJEWADI,PHASE-IPLOT NO. 15A,RAJIV GANDHI-PUNE MAHARASHTRA',
  },
  {
    vendorName: 'Smartify Software Solutions LLP',
    vendorCode: 'SMAR014',
    address: '1209, 12th Floor Block 9 MIG, Khajaguda, Nanakramguda Rd, ChHYDERABAD TELANGANAINDIA 500104',
  },
  {
    vendorName: 'Somshanti Enterprises',
    vendorCode: 'SOMS001',
    address: 'PuneCST No. -881/882, Flat No.-2,Nakoda BuildingFirst FloorBhavani PethPUNE MAHARASHTRA',
  },
  {
    vendorName: 'Urgent Courier',
    vendorCode: 'URGE003',
    address: 'GANESH NAGAR, PANCH KUTIR, IITANDHERI (EAST), MUMBAIROOM NO4, SHAKTI CO-OP. HSG.MUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'Voice Kraft Productions',
    vendorCode: 'VOIC003',
    address: 'MIG-50MIG-50, THB Colony, Raviryal, Hyderabad 500005THB ColonyHYDERABAD TELANGANA',
  },
  {
    vendorName: 'White Globe Pvt. Ltd.',
    vendorCode: 'WHIT005',
    address: '702Stellar Spaces, Opposite Zensar IT Park, Kharadi, Pune7thOffice no. 702, 7th Floor,PUNE MAHARASHTRA',
  },
  {
    vendorName: 'TrackOn Courier',
    vendorCode: 'TRAN025',
    address: 'Gamdevi HSG, Soc, Opp. Dhiraj Gaurav height, off link road,SShop no13, Adarsh Ng Andheri WMUMBAI MAHARASHTRA',
  },
  {
    vendorName: 'VIVEK ELECTRICALS',
    vendorCode: 'VIVE005',
    address: '2/83, Kohinoor Compound,NaigaonDADAR MAHARASHTRA',
  },
  {
    vendorName: 'VOICE KRAFT PRODUCTIONS',
    vendorCode: 'VOIC003',
    address: 'MIG-50MIG-50, THB Colony, Raviryal, Hyderabad 500005THB ColonyHYDERABAD TELANGANA',
  },
];

const ALLOWED_VENDOR_NAMES = [
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
  'Track On Courier',
];

const normalizeKey = (value) => String(value || '').trim().toLowerCase();
const normalizeSpaces = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const allowedNameMap = new Map(
  ALLOWED_VENDOR_NAMES.map((name) => [normalizeKey(name), name])
);

const canonicalizeName = (name) => {
  const normalized = normalizeKey(name);
  return allowedNameMap.get(normalized) || normalizeSpaces(name);
};

const dedupeByName = (entries) => {
  const byName = new Map();
  entries.forEach((entry) => {
    const nameKey = normalizeKey(entry.vendorName);
    if (!nameKey) return;
    const existing = byName.get(nameKey);
    if (!existing) {
      byName.set(nameKey, entry);
      return;
    }

    const entryAddress = entry.address || '';
    const existingAddress = existing.address || '';
    if (!existingAddress && entryAddress) {
      existing.address = entryAddress;
    }
    if (!existing.vendorCode && entry.vendorCode) {
      existing.vendorCode = entry.vendorCode;
    }

    if (entryAddress.length > existingAddress.length) {
      existing.address = entryAddress;
    }
  });

  return Array.from(byName.values());
};

const resolveCodeConflicts = (entries) => {
  const byCode = new Map();
  const skipped = [];

  entries.forEach((entry) => {
    const codeKey = normalizeKey(entry.vendorCode);
    if (!codeKey) {
      skipped.push({ entry, reason: 'Missing vendor code' });
      return;
    }

    const existing = byCode.get(codeKey);
    if (!existing) {
      byCode.set(codeKey, entry);
      return;
    }

    const existingAddress = existing.address || '';
    const entryAddress = entry.address || '';
    if (entryAddress && entryAddress.length > existingAddress.length) {
      skipped.push({ entry: existing, reason: `Duplicate vendor code ${entry.vendorCode}` });
      byCode.set(codeKey, entry);
      return;
    }

    skipped.push({ entry, reason: `Duplicate vendor code ${entry.vendorCode}` });
  });

  return { entries: Array.from(byCode.values()), skipped };
};

const normalizeEntries = RAW_ENTRIES.map((entry) => ({
  vendorName: canonicalizeName(entry.vendorName),
  vendorCode: normalizeSpaces(entry.vendorCode),
  address: normalizeSpaces(entry.address),
}));

const deduped = dedupeByName(normalizeEntries);
const { entries, skipped } = resolveCodeConflicts(deduped);

const existingRows = db.prepare('SELECT id, vendor_name, vendor_code, address FROM vendors').all();
const existingByName = new Map(existingRows.map((row) => [normalizeKey(row.vendor_name), row]));
const existingByCode = new Map(existingRows
  .filter((row) => row.vendor_code)
  .map((row) => [normalizeKey(row.vendor_code), row])
);

const insertStmt = db.prepare(`
  INSERT INTO vendors (
    vendor_code,
    vendor_name,
    address,
    contact_number,
    mail_id,
    bp_name
  )
  VALUES (?, ?, ?, '', '', ?)
`);

const updateStmt = db.prepare(`
  UPDATE vendors
  SET vendor_code = ?,
      address = ?
  WHERE id = ?
`);

let inserted = 0;
let updated = 0;
const skippedDb = [];

const importTransaction = db.transaction(() => {
  entries.forEach((entry) => {
    const nameKey = normalizeKey(entry.vendorName);
    const codeKey = normalizeKey(entry.vendorCode);
    if (!nameKey || !codeKey) {
      skippedDb.push({ entry, reason: 'Missing vendor name or vendor code' });
      return;
    }

    const existingByNameRow = existingByName.get(nameKey);
    if (existingByNameRow) {
      const existingByCodeRow = existingByCode.get(codeKey);
      if (existingByCodeRow && existingByCodeRow.id !== existingByNameRow.id) {
        skippedDb.push({ entry, reason: `Vendor code already used by ${existingByCodeRow.vendor_name}` });
        return;
      }

      const resolvedAddress = entry.address || existingByNameRow.address || '';
      updateStmt.run(entry.vendorCode, resolvedAddress, existingByNameRow.id);
      updated += 1;
      existingByCode.set(codeKey, existingByNameRow);
      return;
    }

    const existingByCodeRow = existingByCode.get(codeKey);
    if (existingByCodeRow) {
      skippedDb.push({ entry, reason: `Vendor code already used by ${existingByCodeRow.vendor_name}` });
      return;
    }

    insertStmt.run(entry.vendorCode, entry.vendorName, entry.address, entry.vendorName);
    inserted += 1;
    existingByName.set(nameKey, { id: -1, vendor_name: entry.vendorName, vendor_code: entry.vendorCode });
    existingByCode.set(codeKey, { id: -1, vendor_name: entry.vendorName, vendor_code: entry.vendorCode });
  });
});

importTransaction();

console.log('Vendor import complete.');
console.log('Inserted:', inserted);
console.log('Updated:', updated);
console.log('Skipped (pre-parse):', skipped.length);
if (skipped.length > 0) {
  console.log('Skipped entries (pre-parse):');
  skipped.forEach((item) => {
    console.log(`- ${item.entry.vendorName} (${item.entry.vendorCode || 'no code'}): ${item.reason}`);
  });
}

console.log('Skipped (db conflicts):', skippedDb.length);
if (skippedDb.length > 0) {
  console.log('Skipped entries (db conflicts):');
  skippedDb.forEach((item) => {
    console.log(`- ${item.entry.vendorName} (${item.entry.vendorCode}): ${item.reason}`);
  });
}

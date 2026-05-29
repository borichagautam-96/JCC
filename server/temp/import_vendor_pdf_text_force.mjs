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

const normalizeKey = (value) => String(value || '').trim().toLowerCase();
const normalizeSpaces = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const updates = RAW_ENTRIES.map((entry) => ({
  vendorName: normalizeSpaces(entry.vendorName),
  vendorCode: normalizeSpaces(entry.vendorCode),
  address: normalizeSpaces(entry.address),
})).filter((entry) => entry.vendorName && entry.vendorCode);

const selectByName = db.prepare('SELECT id, vendor_name, vendor_code FROM vendors WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))');
const selectByCode = db.prepare('SELECT id, vendor_name FROM vendors WHERE LOWER(TRIM(vendor_code)) = LOWER(TRIM(?))');
const updateStmt = db.prepare('UPDATE vendors SET vendor_code = ?, address = ? WHERE id = ?');
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

let updated = 0;
let inserted = 0;
const skipped = [];

const importTransaction = db.transaction(() => {
  updates.forEach((entry) => {
    const existingByName = selectByName.get(entry.vendorName);
    if (existingByName) {
      const existingByCode = selectByCode.get(entry.vendorCode);
      if (existingByCode && existingByCode.id !== existingByName.id) {
        skipped.push({ entry, reason: `Vendor code already used by ${existingByCode.vendor_name}` });
        return;
      }
      updateStmt.run(entry.vendorCode, entry.address, existingByName.id);
      updated += 1;
      return;
    }

    const existingByCode = selectByCode.get(entry.vendorCode);
    if (existingByCode) {
      skipped.push({ entry, reason: `Vendor code already used by ${existingByCode.vendor_name}` });
      return;
    }

    insertStmt.run(entry.vendorCode, entry.vendorName, entry.address, entry.vendorName);
    inserted += 1;
  });
});

importTransaction();

const sample = selectByName.get('ALLWYN JUMBO PRINTS AND EXCHANGER PVT LTD');

console.log('Vendor import complete.');
console.log('Updated:', updated);
console.log('Inserted:', inserted);
console.log('Skipped:', skipped.length);
if (skipped.length > 0) {
  skipped.forEach((item) => {
    console.log(`- ${item.entry.vendorName} (${item.entry.vendorCode}): ${item.reason}`);
  });
}
console.log('Sample check:', sample);

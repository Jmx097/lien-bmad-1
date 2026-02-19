"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECORDS_HEADERS = void 0;
exports.mapToRecordsRow = mapToRecordsRow;
exports.mapToRecordsRows = mapToRecordsRows;
// ---------------------------------------------------------------------------
// Business name detection
// ---------------------------------------------------------------------------
const BUSINESS_SUFFIXES = /\b(inc|llc|corp|ltd|co|lp|llp|pllc|pc|pa|na|dba|company|corporation|incorporated|limited|associates|group|trust|fund|entity|services|solutions|systems|technologies|tech|industries|enterprises|holdings|management|partners|bank|financial|realty|properties|investments|ventures|consulting|international)\b/i;
function isBusinessName(name) {
    if (BUSINESS_SUFFIXES.test(name))
        return true;
    // All-uppercase multi-word strings with digits/ampersands are typically businesses
    if (/[0-9&]/.test(name))
        return true;
    // Has 3+ words all-uppercase → likely business
    const words = name.trim().split(/\s+/);
    if (words.length >= 3 && words.every(w => w === w.toUpperCase() && /^[A-Z]/.test(w)))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Name parser
// IRS NFTL lists names as LASTNAME FIRSTNAME MIDDLE or BUSINESS NAME
// ---------------------------------------------------------------------------
function parseName(raw) {
    const name = raw.trim();
    if (!name)
        return { businessPersonal: "Personal", company: "", firstName: "", lastName: "" };
    if (isBusinessName(name)) {
        return { businessPersonal: "Business", company: name, firstName: "", lastName: "" };
    }
    // Personal: IRS format is typically "LASTNAME FIRSTNAME [MIDDLE]"
    const parts = name.split(/\s+/);
    if (parts.length === 1) {
        return { businessPersonal: "Personal", company: "", firstName: "", lastName: parts[0] };
    }
    const lastName = parts[0];
    const firstName = parts.slice(1).join(" ");
    return { businessPersonal: "Personal", company: "", firstName, lastName };
}
// ---------------------------------------------------------------------------
// Address parser — handles "123 MAIN ST, CITY, CA 90210"
// ---------------------------------------------------------------------------
function parseAddress(raw) {
    const address = raw.trim();
    if (!address)
        return { street: "", city: "", state: "", zip: "" };
    // Standard US: "..., CITY, ST XXXXX[-XXXX]"
    const full = address.match(/^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (full) {
        return {
            street: full[1].trim(),
            city: full[2].trim(),
            state: full[3].trim(),
            zip: full[4].trim(),
        };
    }
    // Compact: "STREET CITY ST XXXXX" (no commas)
    const compact = address.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (compact) {
        // Everything before state is "street city" — split on last space run
        const streetCity = compact[1].trim();
        const lastSpace = streetCity.lastIndexOf(" ");
        return {
            street: lastSpace > 0 ? streetCity.substring(0, lastSpace).trim() : streetCity,
            city: lastSpace > 0 ? streetCity.substring(lastSpace + 1).trim() : "",
            state: compact[2],
            zip: compact[3],
        };
    }
    // Fallback — can't parse
    return { street: address, city: "", state: "CA", zip: "" };
}
// ---------------------------------------------------------------------------
// Schema mapping to Records tab columns
// ---------------------------------------------------------------------------
exports.RECORDS_HEADERS = [
    "Site Id",
    "LienOrReceiveDate",
    "Amount",
    "LeadType",
    "LeadSource",
    "LiabilityType",
    "BusinessPersonal",
    "Company",
    "FirstName",
    "LastName",
    "Street",
    "City",
    "State",
    "Zip",
];
function mapToRecordsRow(record) {
    const { businessPersonal, company, firstName, lastName } = parseName(record.debtor_name);
    const { street, city, state, zip } = parseAddress(record.debtor_address);
    // LiabilityType: prefer document_type (from PDF history modal), fall back to ucc_type
    const liabilityType = record.document_type || record.ucc_type || "Federal Tax Lien";
    return [
        "CA_SOS", // Site Id
        record.filing_date, // LienOrReceiveDate (MM/DD/YYYY)
        record.amount, // Amount (from PDF, "" if unavailable)
        "Tax Lien", // LeadType
        "CA_SOS_UCC", // LeadSource
        liabilityType, // LiabilityType
        businessPersonal, // BusinessPersonal
        company, // Company
        firstName, // FirstName
        lastName, // LastName
        street, // Street
        city, // City
        state || "CA", // State
        zip, // Zip
    ];
}
function mapToRecordsRows(records) {
    return records.map(mapToRecordsRow);
}

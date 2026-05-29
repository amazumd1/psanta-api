const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, "config.env") });
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const StrListing = require("../models/StrListing");

function zip3(zip) {
  return String(zip || "").replace(/\D/g, "").slice(0, 3);
}

function makePreview(item) {
  return [
    "SHORT-TERM RENTAL LISTING",
    `Headline: ${item.public_title}`,
    `Location: ${item.city}, ${item.stateName}`,
    `Type: ${item.propertyType}`,
    `${item.beds} BR â€¢ ${item.baths} BA â€¢ Sleeps up to ${item.sleeps}`,
    `Nightly: from $${item.nightly} â€¢ Cleaning fee: $${item.cleaningFee} â€¢ Min stay: ${item.minStay} nights`,
    `Amenities: ${item.amenities.join(", ")}`,
    `Check-in: 4:00 PM â€¢ Check-out: 11:00 AM â€¢ Method: Self check-in`,
    `Parking: ${item.parking}`,
    `Standout: ${item.standout.join(", ")}`,
    "Description:",
    `${item.description}`,
    "",
    "This PropertySanta demo listing is prepared for owner matching, turnover cleaning, restock, handyman, and curated service workflows.",
  ].join("\n");
}

const LISTINGS = [
  // Florida â€” South Florida / Gulf / Central
  {
    listing_id: "seed_fl_miami_beach_33139",
    public_title: "Miami Beach studio near dining and beach access",
    city: "Miami Beach",
    state: "FL",
    stateName: "Florida",
    zip: "33139",
    propertyType: "condo",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 185,
    cleaningFee: 85,
    minStay: 2,
    parking: "Paid parking nearby",
    amenities: ["WiFi", "Kitchen", "Air conditioning", "Workspace", "Beach access"],
    standout: ["Beach nearby", "Walkable area", "Self check-in"],
    description:
      "Clean Miami Beach guest studio positioned for short stays, digital-nomad guests, and recurring turnover service.",
    cover_url:
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_fort_lauderdale_33301",
    public_title: "Las Olas guest suite with patio-ready setup",
    city: "Fort Lauderdale",
    state: "FL",
    stateName: "Florida",
    zip: "33301",
    propertyType: "townhome",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 230,
    cleaningFee: 95,
    minStay: 2,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Washer", "Dryer", "Patio"],
    standout: ["Near Las Olas", "Outdoor seating", "Family friendly"],
    description:
      "Fort Lauderdale listing built for polished guest turnover, patio staging, and local maintenance readiness.",
    cover_url:
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_pompano_beach_33062",
    public_title: "Pompano beach cottage with pool-service potential",
    city: "Pompano Beach",
    state: "FL",
    stateName: "Florida",
    zip: "33062",
    propertyType: "house",
    beds: 2,
    baths: 1,
    sleeps: 5,
    nightly: 175,
    cleaningFee: 90,
    minStay: 2,
    parking: "Free parking",
    amenities: ["WiFi", "Kitchen", "Pool", "Air conditioning", "Outdoor seating"],
    standout: ["Pool", "Beach nearby", "Self check-in"],
    description:
      "Compact coastal house ideal for recurring pool-area reset, beach guest turnover, and supply restock.",
    cover_url:
      "https://images.unsplash.com/photo-1600047509358-9dc75507daeb?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600047509358-9dc75507daeb?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_boca_raton_33432",
    public_title: "Boca Raton furnished townhome for executive stays",
    city: "Boca Raton",
    state: "FL",
    stateName: "Florida",
    zip: "33432",
    propertyType: "townhome",
    beds: 3,
    baths: 2.5,
    sleeps: 6,
    nightly: 260,
    cleaningFee: 125,
    minStay: 3,
    parking: "Garage parking",
    amenities: ["WiFi", "Kitchen", "Washer", "Dryer", "Workspace"],
    standout: ["Executive stay", "Garage", "Monthly-ready"],
    description:
      "Boca Raton furnished townhome designed for higher-value guest matching and recurring property care.",
    cover_url:
      "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_west_palm_33401",
    public_title: "West Palm apartment near downtown and waterfront",
    city: "West Palm Beach",
    state: "FL",
    stateName: "Florida",
    zip: "33401",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 3,
    nightly: 165,
    cleaningFee: 80,
    minStay: 2,
    parking: "Street parking",
    amenities: ["WiFi", "Kitchen", "Air conditioning", "Workspace"],
    standout: ["Downtown access", "Waterfront nearby", "Walkable"],
    description:
      "Urban West Palm apartment with simple STR cleaning and restock flow for fast same-day turns.",
    cover_url:
      "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600573472591-ee6981cf35b6?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_orlando_32819",
    public_title: "Orlando family stay near attractions",
    city: "Orlando",
    state: "FL",
    stateName: "Florida",
    zip: "32819",
    propertyType: "house",
    beds: 4,
    baths: 3,
    sleeps: 10,
    nightly: 295,
    cleaningFee: 165,
    minStay: 3,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Pool", "Washer", "Dryer", "Game room"],
    standout: ["Family friendly", "Attraction corridor", "Pool"],
    description:
      "High-occupancy Orlando stay suited for repeatable family turnover cleaning and inventory checklist workflows.",
    cover_url:
      "https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_tampa_33602",
    public_title: "Tampa downtown furnished condo with workspace",
    city: "Tampa",
    state: "FL",
    stateName: "Florida",
    zip: "33602",
    propertyType: "condo",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 210,
    cleaningFee: 100,
    minStay: 2,
    parking: "Assigned parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Gym", "Washer", "Dryer"],
    standout: ["Downtown", "Workspace", "Business travel"],
    description:
      "Tampa condo positioned for professional guests, scheduled cleaning, linen refresh, and maintenance checks.",
    cover_url:
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600573472556-e636c2acda82?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_fl_port_st_lucie_34952",
    public_title: "Port St. Lucie living-room ready STR pilot",
    city: "Port St. Lucie",
    state: "FL",
    stateName: "Florida",
    zip: "34952",
    propertyType: "house",
    beds: 3,
    baths: 2,
    sleeps: 6,
    nightly: 190,
    cleaningFee: 110,
    minStay: 2,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Washer", "Dryer", "Patio"],
    standout: ["PropertySanta pilot", "Room-package ready", "Family friendly"],
    description:
      "Port St. Lucie pilot home for curated living-room package, cleaning subscription, and maintenance reporting demo.",
    cover_url:
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600047508788-786f3865b4b1?auto=format&fit=crop&w=1200&q=82",
    ],
  },

  // California
  {
    listing_id: "seed_ca_los_angeles_90028",
    public_title: "Hollywood furnished apartment with work-ready setup",
    city: "Los Angeles",
    state: "CA",
    stateName: "California",
    zip: "90028",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 3,
    nightly: 225,
    cleaningFee: 105,
    minStay: 2,
    parking: "Paid parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Air conditioning"],
    standout: ["Hollywood", "Work-ready", "Walkable"],
    description:
      "Los Angeles apartment for furnished stays, creator guests, workspace setup, and polished turnover service.",
    cover_url:
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1618220179428-22790b461013?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_santa_monica_90401",
    public_title: "Santa Monica beachside rental with premium reset flow",
    city: "Santa Monica",
    state: "CA",
    stateName: "California",
    zip: "90401",
    propertyType: "condo",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 340,
    cleaningFee: 150,
    minStay: 3,
    parking: "Assigned parking",
    amenities: ["WiFi", "Kitchen", "Balcony", "Workspace", "Washer", "Dryer"],
    standout: ["Beach nearby", "Premium stay", "Balcony"],
    description:
      "Santa Monica listing built for premium guest expectations, quality cleaning checks, and owner reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210491369-e753d80a41f3?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_san_diego_92101",
    public_title: "San Diego downtown condo near waterfront",
    city: "San Diego",
    state: "CA",
    stateName: "California",
    zip: "92101",
    propertyType: "condo",
    beds: 2,
    baths: 2,
    sleeps: 5,
    nightly: 255,
    cleaningFee: 125,
    minStay: 2,
    parking: "Garage parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Gym", "Washer", "Dryer"],
    standout: ["Downtown", "Waterfront nearby", "Garage"],
    description:
      "San Diego condo ideal for business and leisure guests with reliable turn-clean and restock operations.",
    cover_url:
      "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566753376-12c8ab7fb75b?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_san_francisco_94107",
    public_title: "San Francisco modern suite for monthly guests",
    city: "San Francisco",
    state: "CA",
    stateName: "California",
    zip: "94107",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 245,
    cleaningFee: 115,
    minStay: 3,
    parking: "Paid garage nearby",
    amenities: ["WiFi", "Kitchen", "Workspace", "Heating", "Washer", "Dryer"],
    standout: ["Monthly-ready", "Workspace", "Urban"],
    description:
      "San Francisco apartment profile for monthly furnished guests, recurring inspection, and owner-ready reports.",
    cover_url:
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_san_jose_95113",
    public_title: "San Jose business travel apartment near downtown",
    city: "San Jose",
    state: "CA",
    stateName: "California",
    zip: "95113",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 3,
    nightly: 215,
    cleaningFee: 95,
    minStay: 2,
    parking: "Garage parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Washer", "Dryer"],
    standout: ["Business travel", "Downtown", "Workspace"],
    description:
      "San Jose work-ready apartment with reliable cleaning checklist and guest supply reset workflow.",
    cover_url:
      "https://images.unsplash.com/photo-1600573472550-8090b5e0745e?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600573472550-8090b5e0745e?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210492493-0946911123ea?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_palm_springs_92262",
    public_title: "Palm Springs pool home with desert guest reset",
    city: "Palm Springs",
    state: "CA",
    stateName: "California",
    zip: "92262",
    propertyType: "house",
    beds: 3,
    baths: 2,
    sleeps: 6,
    nightly: 310,
    cleaningFee: 160,
    minStay: 3,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Pool", "Patio", "Air conditioning"],
    standout: ["Pool", "Outdoor living", "Photo-ready"],
    description:
      "Palm Springs pool home suited for high-visual STR presentation, outdoor reset, and maintenance reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_ca_irvine_92618",
    public_title: "Irvine clean furnished townhome for family stays",
    city: "Irvine",
    state: "CA",
    stateName: "California",
    zip: "92618",
    propertyType: "townhome",
    beds: 3,
    baths: 2.5,
    sleeps: 6,
    nightly: 275,
    cleaningFee: 135,
    minStay: 3,
    parking: "Garage parking",
    amenities: ["WiFi", "Kitchen", "Washer", "Dryer", "Workspace", "Garage"],
    standout: ["Family friendly", "Garage", "Long-stay ready"],
    description:
      "Irvine furnished townhome designed for family stays, clean staging, and monthly maintenance visibility.",
    cover_url:
      "https://images.unsplash.com/photo-1600566753191-17f0baa2a6c3?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566753191-17f0baa2a6c3?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600607687644-c7171b42498b?auto=format&fit=crop&w=1200&q=82",
    ],
  },
];


// EXTRA_PREMIUM_USA_LISTINGS_V2
const EXTRA_PREMIUM_USA_LISTINGS_V2 = [
  {
    listing_id: "seed_premium_fl_naples_34102",
    public_title: "Naples coastal villa with pool and guest-ready patio",
    city: "Naples",
    state: "FL",
    stateName: "Florida",
    zip: "34102",
    propertyType: "villa",
    beds: 4,
    baths: 3.5,
    sleeps: 8,
    nightly: 520,
    cleaningFee: 225,
    minStay: 4,
    parking: "Garage and driveway parking",
    amenities: ["WiFi", "Kitchen", "Pool", "Patio", "Washer", "Dryer", "Workspace"],
    standout: ["Luxury pool home", "Coastal market", "Premium reset"],
    description:
      "Premium Naples villa designed for high-touch turnover cleaning, patio staging, linen reset, and owner-ready service reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_key_biscayne_33149",
    public_title: "Key Biscayne ocean-style condo with resort feel",
    city: "Key Biscayne",
    state: "FL",
    stateName: "Florida",
    zip: "33149",
    propertyType: "condo",
    beds: 2,
    baths: 2,
    sleeps: 5,
    nightly: 430,
    cleaningFee: 175,
    minStay: 3,
    parking: "Assigned garage parking",
    amenities: ["WiFi", "Kitchen", "Balcony", "Pool", "Gym", "Washer", "Dryer"],
    standout: ["Island stay", "Beach nearby", "Premium condo"],
    description:
      "Key Biscayne condo positioned for resort-style guests, premium cleaning standards, beach supply restock, and inspection workflow.",
    cover_url:
      "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210491369-e753d80a41f3?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_coral_gables_33134",
    public_title: "Coral Gables executive apartment near dining and shops",
    city: "Coral Gables",
    state: "FL",
    stateName: "Florida",
    zip: "33134",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 3,
    nightly: 240,
    cleaningFee: 100,
    minStay: 2,
    parking: "Street or garage parking nearby",
    amenities: ["WiFi", "Kitchen", "Workspace", "Air conditioning", "Laundry"],
    standout: ["Executive stay", "Walkable area", "Premium apartment"],
    description:
      "Clean Coral Gables apartment for business travelers, curated staging, quick turnover cleaning, and restock checklist execution.",
    cover_url:
      "https://images.unsplash.com/photo-1618220179428-22790b461013?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1618220179428-22790b461013?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210492493-0946911123ea?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_anna_maria_34216",
    public_title: "Anna Maria island beach house with family-ready layout",
    city: "Anna Maria",
    state: "FL",
    stateName: "Florida",
    zip: "34216",
    propertyType: "house",
    beds: 3,
    baths: 2,
    sleeps: 7,
    nightly: 395,
    cleaningFee: 185,
    minStay: 3,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Patio", "Washer", "Dryer", "Beach gear"],
    standout: ["Island market", "Family friendly", "Beach reset"],
    description:
      "Anna Maria beach house prepared for family arrivals, beach gear restock, outdoor cleanup, and fast hospitality reset.",
    cover_url:
      "https://images.unsplash.com/photo-1600047509358-9dc75507daeb?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600047509358-9dc75507daeb?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_sarasota_34236",
    public_title: "Sarasota downtown luxury apartment with bay access",
    city: "Sarasota",
    state: "FL",
    stateName: "Florida",
    zip: "34236",
    propertyType: "apartment",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 310,
    cleaningFee: 140,
    minStay: 2,
    parking: "Assigned parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Balcony", "Washer", "Dryer"],
    standout: ["Downtown Sarasota", "Bay nearby", "Premium apartment"],
    description:
      "Sarasota apartment with polished guest flow, downtown access, premium cleaning standards, and recurring owner reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600573472550-8090b5e0745e?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600573472550-8090b5e0745e?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566753376-12c8ab7fb75b?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_winter_park_32789",
    public_title: "Winter Park designer guest suite near Park Avenue",
    city: "Winter Park",
    state: "FL",
    stateName: "Florida",
    zip: "32789",
    propertyType: "private suite",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 195,
    cleaningFee: 75,
    minStay: 2,
    parking: "Driveway parking",
    amenities: ["WiFi", "Workspace", "Air conditioning", "Mini fridge", "Coffee station"],
    standout: ["Private suite", "Designer feel", "Walkable district"],
    description:
      "Premium private suite for couples or business travelers with small-format cleaning, coffee restock, and quality inspection.",
    cover_url:
      "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_fl_delray_beach_33483",
    public_title: "Delray Beach coastal bungalow with outdoor lounge",
    city: "Delray Beach",
    state: "FL",
    stateName: "Florida",
    zip: "33483",
    propertyType: "bungalow",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 285,
    cleaningFee: 125,
    minStay: 2,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Patio", "Washer", "Dryer", "Beach gear"],
    standout: ["Coastal bungalow", "Outdoor lounge", "Beach nearby"],
    description:
      "Delray Beach bungalow with curated outdoor reset, guest supply restock, and repeatable turnover cleaning plan.",
    cover_url:
      "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600047508788-786f3865b4b1?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_malibu_90265",
    public_title: "Malibu ocean-view home with premium guest reset",
    city: "Malibu",
    state: "CA",
    stateName: "California",
    zip: "90265",
    propertyType: "house",
    beds: 3,
    baths: 3,
    sleeps: 6,
    nightly: 780,
    cleaningFee: 300,
    minStay: 4,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Ocean view", "Patio", "Washer", "Dryer"],
    standout: ["Ocean view", "Luxury stay", "Premium reset"],
    description:
      "Malibu home designed for luxury guest expectations, outdoor staging, high-touch cleaning, and detailed inspection reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_beverly_hills_90210",
    public_title: "Beverly Hills luxury guest house with private entry",
    city: "Beverly Hills",
    state: "CA",
    stateName: "California",
    zip: "90210",
    propertyType: "guest house",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 390,
    cleaningFee: 125,
    minStay: 2,
    parking: "Private parking",
    amenities: ["WiFi", "Workspace", "Kitchenette", "Air conditioning", "Private entry"],
    standout: ["Luxury room", "Private entry", "Premium guest house"],
    description:
      "Private Beverly Hills guest house positioned for premium short stays, light-touch cleaning, and high-trust guest experience.",
    cover_url:
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_newport_beach_92660",
    public_title: "Newport Beach modern condo with marina-inspired style",
    city: "Newport Beach",
    state: "CA",
    stateName: "California",
    zip: "92660",
    propertyType: "condo",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 360,
    cleaningFee: 155,
    minStay: 3,
    parking: "Garage parking",
    amenities: ["WiFi", "Kitchen", "Balcony", "Workspace", "Washer", "Dryer"],
    standout: ["Coastal condo", "Premium market", "Garage"],
    description:
      "Newport Beach condo prepared for coastal guest stays, premium photo presentation, cleaning, and restock operations.",
    cover_url:
      "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600607687644-c7171b42498b?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_laguna_beach_92651",
    public_title: "Laguna Beach artist apartment near coastal trails",
    city: "Laguna Beach",
    state: "CA",
    stateName: "California",
    zip: "92651",
    propertyType: "apartment",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 275,
    cleaningFee: 110,
    minStay: 2,
    parking: "Street parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Balcony", "Beach access"],
    standout: ["Coastal trails", "Artist stay", "Walkable"],
    description:
      "Laguna Beach apartment with boutique guest feel, curated staging, beach reset, and clean service workflow.",
    cover_url:
      "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600573472591-ee6981cf35b6?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_palo_alto_94301",
    public_title: "Palo Alto executive apartment for monthly stays",
    city: "Palo Alto",
    state: "CA",
    stateName: "California",
    zip: "94301",
    propertyType: "apartment",
    beds: 2,
    baths: 2,
    sleeps: 4,
    nightly: 345,
    cleaningFee: 145,
    minStay: 5,
    parking: "Assigned parking",
    amenities: ["WiFi", "Kitchen", "Workspace", "Washer", "Dryer", "Heating"],
    standout: ["Executive stay", "Monthly-ready", "Workspace"],
    description:
      "Palo Alto furnished apartment built for business travelers, monthly stays, scheduled cleaning, and owner visibility.",
    cover_url:
      "https://images.unsplash.com/photo-1600573472556-e636c2acda82?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600573472556-e636c2acda82?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_napa_94559",
    public_title: "Napa wine-country cottage with premium arrival setup",
    city: "Napa",
    state: "CA",
    stateName: "California",
    zip: "94559",
    propertyType: "cottage",
    beds: 2,
    baths: 1,
    sleeps: 4,
    nightly: 330,
    cleaningFee: 130,
    minStay: 3,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Patio", "Heating", "Coffee station"],
    standout: ["Wine country", "Cottage stay", "Arrival setup"],
    description:
      "Napa cottage designed for premium arrival presentation, patio reset, coffee restock, and high-quality turnover care.",
    cover_url:
      "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_santa_barbara_93101",
    public_title: "Santa Barbara Spanish-style suite near downtown",
    city: "Santa Barbara",
    state: "CA",
    stateName: "California",
    zip: "93101",
    propertyType: "private suite",
    beds: 1,
    baths: 1,
    sleeps: 2,
    nightly: 260,
    cleaningFee: 95,
    minStay: 2,
    parking: "Street parking",
    amenities: ["WiFi", "Kitchenette", "Workspace", "Patio", "Air conditioning"],
    standout: ["Spanish-style suite", "Downtown nearby", "Boutique feel"],
    description:
      "Santa Barbara private suite with boutique setup, small-format service flow, guest refresh, and easy owner reporting.",
    cover_url:
      "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1600566752355-35792bedcfea?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1200&q=82",
    ],
  },
  {
    listing_id: "seed_premium_ca_south_lake_tahoe_96150",
    public_title: "South Lake Tahoe mountain house with hot-tub reset",
    city: "South Lake Tahoe",
    state: "CA",
    stateName: "California",
    zip: "96150",
    propertyType: "house",
    beds: 4,
    baths: 3,
    sleeps: 10,
    nightly: 450,
    cleaningFee: 240,
    minStay: 3,
    parking: "Driveway parking",
    amenities: ["WiFi", "Kitchen", "Hot tub", "Fireplace", "Washer", "Dryer"],
    standout: ["Mountain stay", "Hot tub", "Family friendly"],
    description:
      "Tahoe mountain home prepared for family stays, hot-tub area reset, winter guest turnover, and maintenance checklist workflows.",
    cover_url:
      "https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=1400&q=82",
    photos: [
      "https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=1400&q=82",
      "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=82",
    ],
  },
];

LISTINGS.push(...EXTRA_PREMIUM_USA_LISTINGS_V2);

const APPLY = process.argv.includes("--apply");

(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing. Check services/api/config.env or .env.local");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const now = new Date();
  const results = [];

  for (const item of LISTINGS) {
    const public_preview = makePreview(item);

    const doc = {
      listing_id: item.listing_id,
      published: true,
      public_title: item.public_title,
      public_preview,
      zip: item.zip,
      zip3: zip3(item.zip),
      city: item.city,
      state: item.state,
      cover_url: item.cover_url,
      photos: item.photos.map((url, index) => ({ url, src: url, image_url: url, sort: index, source: "propertysanta_seed" })),
      photo_count: item.photos.length,
      source: "propertysanta_seed",
      listing_type: "short_term_rental",
      updatedAt: now,
      publishedAt: now,
      draft: {
        source: "propertysanta_seed",
        listingUrl: "",
        title: item.public_title,
        headline: item.public_title,
        city: item.city,
        state: item.state,
        zip: item.zip,
        beds: String(item.beds),
        baths: String(item.baths),
        sleeps: String(item.sleeps),
        propertyType: item.propertyType,
        nightlyPrice: String(item.nightly),
        cleaningFee: String(item.cleaningFee),
        minStay: String(item.minStay),
        amenities: item.amenities,
        standout: item.standout,
        cover_url: item.cover_url,
        photos: item.photos.map((url, index) => ({ url, src: url, image_url: url, sort: index, source: "propertysanta_seed" })),
        locationHint: {
          address: "",
          city: item.city,
          state: item.stateName,
          zip: item.zip,
          includeExactAddress: false,
          source: "propertysanta_seed",
          confidence: "seed_demo",
        },
      },
      fields: {
        city: item.city,
        state: item.state,
        zip: item.zip,
        locationLabel: `${item.city}, ${item.stateName} ${item.zip}`,
        locationConfidence: "seed_demo",
      },
    };

    const existing = await StrListing.findOne({ listing_id: item.listing_id }).lean();

    results.push({
      listing_id: item.listing_id,
      action: existing ? "update" : "insert",
      zip: item.zip,
      city: item.city,
      state: item.state,
      title: item.public_title,
    });

    if (APPLY) {
      await StrListing.updateOne(
        { listing_id: item.listing_id },
        {
          $set: doc,
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );
    }
  }

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.table(results);
  console.log("");
  console.log(`Total seed listings: ${results.length}`);

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});


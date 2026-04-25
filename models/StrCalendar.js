const mongoose = require("mongoose");

const StrCalendarSchema = new mongoose.Schema(
  {
    calendar_id: { type: String, index: true },
    zip: { type: String, default: "" },
    ical_urls: { type: [String], default: [] },
    sources: { type: [String], default: [] },
    last_sync_at: { type: String, default: "" },
    blocks: {
      type: [
        {
          start: String, // YYYY-MM-DD
          end: String,   // YYYY-MM-DD (inclusive)
          source: String,
          url: String,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StrCalendar", StrCalendarSchema);

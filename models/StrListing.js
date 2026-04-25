const mongoose = require("mongoose");

const StrListingSchema = new mongoose.Schema(
    {
        // client-generated stable id (stored in localStorage on frontend)
        listing_id: { type: String, required: true, index: true },

        // optional ownership (becomes enforced once set)
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

        zip: { type: String, default: "", index: true },
        zip3: { type: String, default: "", index: true },
        state: { type: String, default: "" },

        // user-entered STR draft object (no scraping MVP)
        draft: { type: mongoose.Schema.Types.Mixed, default: null },

        // public preview text (from buildStrDraftText on frontend)
        public_preview: { type: String, default: "" },
        public_title: { type: String, default: "" },


        // photos
        photos: {
            type: [
                {
                    url: { type: String, required: true },
                    publicId: { type: String, default: "" },
                    source: { type: String, default: "link" }, // link|upload|data
                    is_cover: { type: Boolean, default: false },
                    createdAt: { type: Date, default: Date.now },
                },
            ],
            default: [],
        },
        cover_url: { type: String, default: "" },

        // publish state
        published: { type: Boolean, default: false, index: true },
        publishedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

StrListingSchema.index({ zip3: 1, published: 1, updatedAt: -1 });
StrListingSchema.index({ listing_id: 1, userId: 1 });

module.exports = mongoose.model("StrListing", StrListingSchema);

const mongoose = require("mongoose");
const { Schema } = mongoose;

const CuratedLookProductSchema = new Schema(
  {
    productId: { type: String, trim: true, maxlength: 140, required: true },
    title: { type: String, trim: true, maxlength: 220 },
    category: { type: String, trim: true, maxlength: 120, index: true },
    productStatus: { type: String, trim: true, maxlength: 80 },
    price: { type: Number, default: null },
    image: { type: String, trim: true, maxlength: 800 },
    sourceName: { type: String, trim: true, maxlength: 140 },
    sourceUrl: { type: String, trim: true, maxlength: 800 },
    sourceProductId: { type: String, trim: true, maxlength: 180 },
    slotKey: { type: String, trim: true, maxlength: 80 },
    slotLabel: { type: String, trim: true, maxlength: 160 },
    role: {
      type: String,
      enum: ["hero", "supporting", "accent", "utility"],
      default: "supporting",
    },
    robotHandlingNote: { type: String, trim: true, maxlength: 500 },
    replacementReason: { type: String, trim: true, maxlength: 300 },
    dealScore: { type: Number, default: null },
    reviewScore: { type: Number, default: null },
  },
  { _id: false }
);

const LaborNeedSchema = new Schema(
  {
    role: { type: String, trim: true, maxlength: 120, index: true },
    label: { type: String, trim: true, maxlength: 160 },
    hours: { type: Number, default: 0 },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const RoomDimensionsSchema = new Schema(
  {
    lengthFt: { type: Number, default: 0 },
    widthFt: { type: Number, default: 0 },
    heightFt: { type: Number, default: 0 },
    ceilingHeightFt: { type: Number, default: 0 },
    approxSqFt: { type: Number, default: 0 },
    walls: { type: Number, default: 4 },
    windows: { type: Number, default: 0 },
    doors: { type: Number, default: 0 },
    notes: { type: String, trim: true, maxlength: 1200 },
  },
  { _id: false }
);

const ReplacementRuleSchema = new Schema(
  {
    slotKey: { type: String, trim: true, maxlength: 80, index: true },
    slotLabel: { type: String, trim: true, maxlength: 160 },
    currentProductId: { type: String, trim: true, maxlength: 140 },
    preferredCategory: { type: String, trim: true, maxlength: 120 },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    requiredDimensions: { type: String, trim: true, maxlength: 240 },
    styleNotes: { type: String, trim: true, maxlength: 500 },
    replaceWhen: { type: String, trim: true, maxlength: 500 },
    supplierPriority: [{ type: String, trim: true, maxlength: 140 }],
  },
  { _id: false }
);

const RobotServiceTaskSchema = new Schema(
  {
    taskId: { type: String, trim: true, maxlength: 120 },
    label: { type: String, trim: true, maxlength: 180 },
    zone: { type: String, trim: true, maxlength: 120 },
    estimatedMinutes: { type: Number, default: 0 },
    robotCapability: { type: String, trim: true, maxlength: 160 },
    humanInLoop: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 700 },
  },
  { _id: false }
);

const RobotServicePlanSchema = new Schema(
  {
    planId: { type: String, trim: true, maxlength: 160, index: true },
    expectedRobot: { type: String, trim: true, maxlength: 160 },
    serviceMode: {
      type: String,
      enum: ["human", "human_in_loop", "neo", "unitree", "hybrid"],
      default: "human_in_loop",
    },
    subscriptionSku: { type: String, trim: true, maxlength: 160 },
    estimatedCleaningMinutes: { type: Number, default: 0 },
    estimatedMaintenanceMinutes: { type: Number, default: 0 },
    monthlyServicePrice: { type: Number, default: 0 },
    tasks: { type: [RobotServiceTaskSchema], default: [] },
    outputFormat: { type: String, trim: true, maxlength: 120, default: "json_ros2_bridge_ready" },
    notes: { type: String, trim: true, maxlength: 1600 },
  },
  { _id: false }
);

const MaintenanceInspectionItemSchema = new Schema(
  {
    checkId: { type: String, trim: true, maxlength: 120 },
    label: { type: String, trim: true, maxlength: 180 },
    zone: { type: String, trim: true, maxlength: 120 },
    severityDefault: {
      type: String,
      enum: ["info", "low", "medium", "high"],
      default: "low",
    },
    reportAction: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const MaintenanceInspectionTemplateSchema = new Schema(
  {
    templateId: { type: String, trim: true, maxlength: 160, index: true },
    title: { type: String, trim: true, maxlength: 220 },
    frequency: { type: String, trim: true, maxlength: 120, default: "after_each_service" },
    items: { type: [MaintenanceInspectionItemSchema], default: [] },
    approvalFlow: { type: String, trim: true, maxlength: 240, default: "route_to_property_center" },
    notes: { type: String, trim: true, maxlength: 1200 },
  },
  { _id: false }
);

const ExternalReferenceSchema = new Schema(
  {
    refId: { type: String, trim: true, maxlength: 180 },
    url: { type: String, trim: true, maxlength: 800 },
    status: { type: String, trim: true, maxlength: 80, default: "planned" },
    notes: { type: String, trim: true, maxlength: 700 },
  },
  { _id: false }
);

const CuratedLookSchema = new Schema(
  {
    lookId: { type: String, trim: true, maxlength: 160, unique: true, sparse: true, index: true },
    title: { type: String, trim: true, maxlength: 220, required: true },
    status: {
      type: String,
      enum: ["draft", "published", "sold", "subscribed", "archived"],
      default: "draft",
      index: true,
    },

    roomCode: { type: String, trim: true, uppercase: true, maxlength: 40, index: true },
    roomTemplateId: { type: String, trim: true, maxlength: 120, index: true },
    roomDimensions: { type: RoomDimensionsSchema, default: () => ({}) },
    designTier: {
      type: String,
      enum: ["tier_1", "tier_2", "tier_3", "custom"],
      default: "tier_1",
      index: true,
    },

    market: { type: String, trim: true, maxlength: 140, index: true },
    serviceArea: { type: String, trim: true, maxlength: 180 },
    zip: { type: String, trim: true, maxlength: 10, index: true },
    primaryCategory: { type: String, trim: true, maxlength: 120, index: true },

    summary: { type: String, trim: true, maxlength: 1200 },
    designIntent: { type: String, trim: true, maxlength: 1600 },
    shopPath: { type: String, trim: true, maxlength: 300 },

    beforeImage: { type: String, trim: true, maxlength: 800 },
    afterImage: { type: String, trim: true, maxlength: 800 },
    aiPredictedDesignUrl: { type: String, trim: true, maxlength: 800 },
    implementedDesignUrl: { type: String, trim: true, maxlength: 800 },
    heroImage: { type: String, trim: true, maxlength: 800 },

    tags: [{ type: String, trim: true, maxlength: 80 }],
    products: { type: [CuratedLookProductSchema], default: [] },
    supplierProducts: { type: [CuratedLookProductSchema], default: [] },
    replacementRules: { type: [ReplacementRuleSchema], default: [] },
    laborNeeds: { type: [LaborNeedSchema], default: [] },

    robotServicePlan: { type: RobotServicePlanSchema, default: () => ({}) },
    estimatedCleaningMinutes: { type: Number, default: 0, index: true },
    maintenanceServicePrice: { type: Number, default: 0 },
    maintenanceInspectionTemplate: { type: MaintenanceInspectionTemplateSchema, default: () => ({}) },
    rosTaskPlanRef: { type: ExternalReferenceSchema, default: () => ({}) },
    base44Ref: { type: ExternalReferenceSchema, default: () => ({}) },

    productCount: { type: Number, default: 0 },
    estimatedProductTotal: { type: Number, default: 0 },
    estimatedLaborHours: { type: Number, default: 0 },

    source: { type: String, trim: true, maxlength: 80, default: "admin_builder", index: true },
    createdBy: { type: String, trim: true, maxlength: 160, default: "admin" },
    soldAt: { type: Date, default: null, index: true },
    subscribedAt: { type: Date, default: null, index: true },
    publishedAt: { type: Date, default: null, index: true },

    reviewStatus: {
      type: String,
      enum: ["new", "reviewed", "approved", "task_created", "pricing_needed", "contacted", "ignored"],
      default: "new",
      index: true,
    },
    adminAction: { type: String, trim: true, maxlength: 120, default: "" },
    adminNote: { type: String, trim: true, maxlength: 1200, default: "" },
    reviewedAt: { type: Date, default: null, index: true },
    reviewedBy: { type: String, trim: true, maxlength: 160, default: "" },

    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

CuratedLookSchema.pre("validate", function curatedLookRobotReadyDefaults(next) {
  const roomCode = String(this.roomCode || "").trim().toUpperCase();
  if (roomCode) this.roomCode = roomCode;

  if (!this.roomTemplateId && roomCode && this.primaryCategory) {
    this.roomTemplateId = `${roomCode}_${String(this.primaryCategory).trim().toLowerCase()}`;
  }

  if (!this.supplierProducts?.length && this.products?.length) {
    this.supplierProducts = this.products;
  }

  if (!this.estimatedCleaningMinutes && this.robotServicePlan?.estimatedCleaningMinutes) {
    this.estimatedCleaningMinutes = this.robotServicePlan.estimatedCleaningMinutes;
  }

  if (!this.maintenanceServicePrice && this.robotServicePlan?.monthlyServicePrice) {
    this.maintenanceServicePrice = this.robotServicePlan.monthlyServicePrice;
  }

  if (this.status === "published" && !this.publishedAt) this.publishedAt = new Date();
  if (this.status === "sold" && !this.soldAt) this.soldAt = new Date();
  if (this.status === "subscribed" && !this.subscribedAt) this.subscribedAt = new Date();

  next();
});

CuratedLookSchema.index({ createdAt: -1 });
CuratedLookSchema.index({ status: 1, createdAt: -1 });
CuratedLookSchema.index({ zip: 1, status: 1, createdAt: -1 });
CuratedLookSchema.index({ primaryCategory: 1, status: 1 });
CuratedLookSchema.index({ reviewStatus: 1, createdAt: -1 });
CuratedLookSchema.index({ roomCode: 1, designTier: 1, status: 1 });
CuratedLookSchema.index({ roomTemplateId: 1, status: 1 });
CuratedLookSchema.index({ "robotServicePlan.planId": 1, status: 1 });
CuratedLookSchema.index({ "rosTaskPlanRef.refId": 1 });
CuratedLookSchema.index({ "base44Ref.refId": 1 });

module.exports = mongoose.models.CuratedLook || mongoose.model("CuratedLook", CuratedLookSchema);
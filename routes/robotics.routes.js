const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const router = express.Router();

const DATA_DIR = path.resolve(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "roboticsRooms.json");
const ROBOTICS_ROOT = path.resolve(__dirname, "../../../robotics");

const FOXGLOVE_TOPICS = [
  "/robot/pose",
  "/robot/path",
  "/robot/live_work_markers",
  "/room/objects",
  "/room/zones",
  "/room/boundary_markers",
  "/room/object_markers",
  "/room/zone_markers",
  "/task/current_step",
  "/task/waypoints",
  "/task/waypoint_markers",
  "/task/service_report",
  "/manipulation/markers",
  "/manipulation/current_action",
  "/manipulation/gripper_state",
  "/manipulation/task_result",
  "/moveit_mtc/request",
  "/propertysanta/manipulation_goals",
  "/isaac_sim/scene_request",
  "/isaac_sim/task_request",
  "/isaac_lab/humanoid_task_request",
  "/propertysanta/isaac_status",
  "/isaac_sim/preview_markers",
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStore() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms: [] }, null, 2));
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readStore() {
  ensureStore();
  const parsed = readJsonFile(DATA_FILE, { rooms: [] });
  return { rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [] };
}

function writeStore(store) {
  ensureStore();
  writeJsonFile(DATA_FILE, { rooms: Array.isArray(store.rooms) ? store.rooms : [] });
}

function makeHttpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function sanitizeRoomId(roomId) {
  const value = String(roomId || "").trim();
  if (!value) throw makeHttpError(400, "roomId is required");

  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw makeHttpError(400, "roomId can only contain letters, numbers, underscore, and dash");
  }

  return value;
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeUnit(unit) {
  return unit === "meters" || unit === "meter" || unit === "m" ? "meters" : "feet";
}

function normalizePose(payload = {}, fallback = {}) {
  return {
    x: asNumber(payload.x, fallback.x || 0),
    y: asNumber(payload.y, fallback.y || 0),
    z: asNumber(payload.z, fallback.z || 0),
    yaw: asNumber(payload.yaw, fallback.yaw || 0),
  };
}

function validateDimensions(dimensions = {}) {
  const issues = [];

  ["length", "width", "height"].forEach((key) => {
    if (!Number.isFinite(Number(dimensions[key])) || Number(dimensions[key]) <= 0) {
      issues.push(`dimensions.${key} must be a positive number`);
    }
  });

  return issues;
}

function normalizeDimensions(payload = {}) {
  return {
    length: asNumber(payload.length, 0),
    width: asNumber(payload.width, 0),
    height: asNumber(payload.height, 0),
    unit: normalizeUnit(payload.unit),
  };
}

function normalizeRobotObject(payload = {}) {
  const id = String(payload.id || "").trim();
  const type = String(payload.type || "").trim();
  const label = String(payload.label || payload.name || id || "").trim();

  if (!id) throw makeHttpError(400, "object.id is required");
  if (!type) throw makeHttpError(400, "object.type is required");
  if (!label) throw makeHttpError(400, "object.label is required");

  return {
    id,
    label,
    type,
    category: payload.category || type,
    pose: normalizePose(payload.pose || payload),
    size: payload.size || null,
    manipulation: payload.manipulation && typeof payload.manipulation === "object"
      ? { ...payload.manipulation }
      : null,
    notes: payload.notes || "",
  };
}

function normalizeZone(payload = {}) {
  const id = String(payload.id || "").trim();
  const type = String(payload.type || "").trim();
  const label = String(payload.label || payload.name || id || "").trim();

  if (!id) throw makeHttpError(400, "zone.id is required");
  if (!type) throw makeHttpError(400, "zone.type is required");
  if (!label) throw makeHttpError(400, "zone.label is required");

  const bounds = Array.isArray(payload.bounds)
    ? payload.bounds.map((point) => ({ x: asNumber(point.x, 0), y: asNumber(point.y, 0) }))
    : [];

  return {
    id,
    label,
    type,
    bounds,
    pose: payload.pose ? normalizePose(payload.pose) : null,
    notes: payload.notes || "",
  };
}

function normalizeWaypoint(key, payload = {}) {
  const waypointKey = String(payload.key || payload.id || payload.name || key || "").trim();

  if (!waypointKey) throw makeHttpError(400, "waypoint key is required");

  return {
    key: waypointKey,
    pose: normalizePose(payload.pose || payload),
    label: payload.label || waypointKey.replace(/_/g, " "),
    notes: payload.notes || "",
  };
}

function normalizePhotoAnnotation(payload = {}, existing = null) {
  const source = payload && typeof payload === "object"
    ? payload
    : existing && typeof existing === "object"
      ? existing
      : {};

  return {
    roomId: source.roomId || "",
    mapping: source.mapping || "homography_v1",
    updatedAt: source.updatedAt || null,
    floorBoundary: Array.isArray(source.floorBoundary)
      ? source.floorBoundary.map((point) => ({ x: asNumber(point.x, 0), y: asNumber(point.y, 0) })).slice(0, 4)
      : [],
    annotations: Array.isArray(source.annotations)
      ? source.annotations.map((item, index) => ({
        id: String(item.id || `annotation_${index + 1}`).trim(),
        kind: String(item.kind || "object").trim(),
        label: String(item.label || item.id || `Annotation ${index + 1}`).trim(),
        box: item.box ? {
          x: asNumber(item.box.x, 0),
          y: asNumber(item.box.y, 0),
          width: asNumber(item.box.width, 0),
          height: asNumber(item.box.height, 0),
        } : null,
        point: item.point ? { x: asNumber(item.point.x, 0), y: asNumber(item.point.y, 0) } : null,
        roomBox: item.roomBox || null,
        roomPose: item.roomPose || null,
        objectType: item.objectType || null,
        zoneType: item.zoneType || null,
      }))
      : [],
  };
}

function normalizeTaskStep(payload = {}, index = 0) {
  const action = String(payload.action || "").trim();
  const target = String(payload.target || "").trim();
  const placeTarget = String(payload.placeTarget || "").trim();
  const surfaceTarget = String(payload.surfaceTarget || "").trim();

  if (!action) throw makeHttpError(400, "task step action is required");
  if (!target && action !== "return_home") throw makeHttpError(400, "task step target is required");

  return {
    step: Number.isFinite(Number(payload.step)) ? Number(payload.step) : index + 1,
    action,
    target: target || "home",
    label: payload.label || `${action} ${target || "home"}`.trim(),
    expectedDurationSec: Number.isFinite(Number(payload.expectedDurationSec))
      ? Number(payload.expectedDurationSec)
      : Number.isFinite(Number(payload.durationSeconds))
        ? Number(payload.durationSeconds)
        : null,
    durationSeconds: Number.isFinite(Number(payload.durationSeconds))
      ? Number(payload.durationSeconds)
      : null,
    placeTarget: placeTarget || undefined,
    surfaceTarget: surfaceTarget || undefined,
    grasp: payload.grasp && typeof payload.grasp === "object" ? { ...payload.grasp } : undefined,
    manipulation: payload.manipulation && typeof payload.manipulation === "object" ? { ...payload.manipulation } : undefined,
    successCriteria: Array.isArray(payload.successCriteria) ? payload.successCriteria : undefined,
    notes: payload.notes || "",
  };
}

function normalizeMaintenanceInspectionTask(payload = {}, index = 0) {
  const checkId = String(payload.checkId || payload.id || `check_${index + 1}`).trim();
  const label = String(payload.label || payload.title || checkId).trim();

  return {
    checkId,
    label,
    zone: String(payload.zone || payload.target || "").trim(),
    severityDefault: ["info", "low", "medium", "high"].includes(String(payload.severityDefault || payload.severity || "").trim())
      ? String(payload.severityDefault || payload.severity).trim()
      : "low",
    reportAction: String(payload.reportAction || payload.action || "Route to Property Center maintenance report.").trim(),
  };
}

function normalizeDesignPackage(payload = {}, existing = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const fallback = existing && typeof existing === "object" ? existing : {};

  return {
    roomCode: String(source.roomCode || fallback.roomCode || "L1").trim().toUpperCase(),
    roomTemplateId: String(source.roomTemplateId || fallback.roomTemplateId || "L1_living_room_port_saint_lucie").trim(),
    designTier: String(source.designTier || fallback.designTier || "tier_1").trim(),
    market: String(source.market || fallback.market || "Port Saint Lucie / South Florida").trim(),
    subscribedService: String(source.subscribedService || fallback.subscribedService || "cleaning_maintenance_robot_ready").trim(),
    predictedCleaningMinutes: asNumber(source.predictedCleaningMinutes, asNumber(fallback.predictedCleaningMinutes, 83)),
    maintenancePriceMonthly: asNumber(source.maintenancePriceMonthly, asNumber(fallback.maintenancePriceMonthly, 149)),
    base44Ref: String(source.base44Ref || fallback.base44Ref || "L1_BASE44_HARDWARE_BOM_PSL_001").trim(),
    rosTaskPlanRef: String(source.rosTaskPlanRef || fallback.rosTaskPlanRef || "L1_ROS2_JSON_PLAN_V1").trim(),
  };
}

function normalizeWaypointMap(input = {}) {
  const output = {};

  Object.entries(input).forEach(([key, value]) => {
    const waypoint = normalizeWaypoint(key, value);
    output[waypoint.key] = waypoint.pose;
  });

  return output;
}

function normalizeRoom(payload = {}, existing = null) {
  const roomId = sanitizeRoomId(payload.roomId || payload.id || existing?.roomId);
  const dimensions = normalizeDimensions(payload.dimensions || existing?.dimensions || {});

  return {
    roomId,
    propertyId: String(payload.propertyId || existing?.propertyId || "demo_property_001").trim(),
    propertyName: String(payload.propertyName || existing?.propertyName || "Demo Property").trim(),
    roomName: String(payload.roomName || payload.name || existing?.roomName || "Untitled Room").trim(),
    source: payload.source || existing?.source || "manual_dimensions_v1",
    sourcePhoto: payload.sourcePhoto || existing?.sourcePhoto || "source/living-room.jpg",
    dimensions,
    robotHomePose: normalizePose(payload.robotHomePose || existing?.robotHomePose || { x: 0, y: 0, z: 0, yaw: 0 }),
    objects: Array.isArray(payload.objects)
      ? payload.objects.map(normalizeRobotObject)
      : Array.isArray(existing?.objects)
        ? existing.objects
        : [],
    zones: Array.isArray(payload.zones)
      ? payload.zones.map(normalizeZone)
      : Array.isArray(existing?.zones)
        ? existing.zones
        : [],
    waypoints: payload.waypoints && typeof payload.waypoints === "object"
      ? normalizeWaypointMap(payload.waypoints)
      : existing?.waypoints && typeof existing.waypoints === "object"
        ? existing.waypoints
        : {},
    taskSequence: Array.isArray(payload.taskSequence)
      ? payload.taskSequence.map(normalizeTaskStep)
      : Array.isArray(existing?.taskSequence)
        ? existing.taskSequence
        : [],
    designPackage: normalizeDesignPackage(payload.designPackage, existing?.designPackage),
    estimatedCleaningMinutes: asNumber(
      payload.estimatedCleaningMinutes,
      asNumber(existing?.estimatedCleaningMinutes, asNumber(payload.designPackage?.predictedCleaningMinutes, 83))
    ),
    maintenanceInspectionTasks: Array.isArray(payload.maintenanceInspectionTasks)
      ? payload.maintenanceInspectionTasks.map(normalizeMaintenanceInspectionTask)
      : Array.isArray(existing?.maintenanceInspectionTasks)
        ? existing.maintenanceInspectionTasks
        : [],
    photoAnnotation: normalizePhotoAnnotation(payload.photoAnnotation, existing?.photoAnnotation),
    notes: payload.notes || existing?.notes || "",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}


function findRoomIndex(store, roomId) {
  return store.rooms.findIndex((item) => item.roomId === roomId);
}

function getRoomOrThrow(roomId) {
  const safeRoomId = sanitizeRoomId(roomId);
  const store = readStore();
  const room = store.rooms.find((item) => item.roomId === safeRoomId);

  if (!room) throw makeHttpError(404, "Robotics room not found");

  return { store, room };
}

function upsertById(items, nextItem) {
  const list = Array.isArray(items) ? [...items] : [];
  const index = list.findIndex((item) => item.id === nextItem.id);

  if (index >= 0) list[index] = { ...list[index], ...nextItem };
  else list.push(nextItem);

  return list;
}

function buildRobotTaskPlan(room) {
  return {
    schemaVersion: "propertysanta.robot_task_plan.v1",
    generatedAt: new Date().toISOString(),
    room: {
      roomId: room.roomId,
      propertyId: room.propertyId,
      propertyName: room.propertyName,
      roomName: room.roomName,
      source: room.source,
      sourcePhoto: room.sourcePhoto,
      dimensions: room.dimensions,
      photoAnnotation: room.photoAnnotation || null,
    },
    robotHomePose: room.robotHomePose,
    objects: room.objects || [],
    zones: room.zones || [],
    waypoints: room.waypoints || {},
    taskSequence: room.taskSequence || [],
    maintenanceInspectionTasks: room.maintenanceInspectionTasks || [],
    foxgloveTopics: FOXGLOVE_TOPICS,
    validation: validateRobotPlan(room, { mode: "export" }),
  };
}


function makeValidationIssue(severity, code, pathName, message, meta = {}) {
  return {
    severity,
    code,
    path: pathName,
    message,
    ...meta,
  };
}

function issueText(issue) {
  if (!issue || typeof issue !== "object") return String(issue || "");
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function hasFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function validatePoseShape(pathName, pose = {}, errors) {
  ["x", "y", "z", "yaw"].forEach((key) => {
    if (!hasFiniteNumber(pose?.[key] ?? 0)) {
      errors.push(makeValidationIssue(
        "error",
        "INVALID_POSE",
        `${pathName}.${key}`,
        "must be numeric"
      ));
    }
  });
}

function validateDuplicateIds(kind, items = [], errors) {
  const seen = new Map();
  const validIds = new Set();

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const id = String(item?.id || "").trim();
    const pathName = `${kind}[${index}].id`;

    if (!id) {
      errors.push(makeValidationIssue("error", "MISSING_ID", pathName, `${kind} id is required`));
      return;
    }

    if (seen.has(id)) {
      errors.push(makeValidationIssue(
        "error",
        "DUPLICATE_ID",
        pathName,
        `duplicate ${kind} id '${id}' also appears at ${kind}[${seen.get(id)}]`,
        { id, firstIndex: seen.get(id), duplicateIndex: index }
      ));
    } else {
      seen.set(id, index);
      validIds.add(id);
    }
  });

  return validIds;
}

function validateRobotPlan(room, options = {}) {
  const mode = options.mode || "draft";
  const errors = [];
  const warnings = [];

  if (!room || typeof room !== "object") {
    errors.push(makeValidationIssue("error", "ROOM_REQUIRED", "room", "room payload is required"));
    return {
      ready: false,
      canSave: false,
      mode,
      severity: "error",
      errors,
      warnings,
      issues: errors.map(issueText),
      blockingIssues: errors.map(issueText),
    };
  }

  if (!String(room.roomId || "").trim()) {
    errors.push(makeValidationIssue("error", "ROOM_ID_REQUIRED", "roomId", "Room ID is required"));
  }

  if (!String(room.roomName || "").trim()) {
    warnings.push(makeValidationIssue("warning", "ROOM_NAME_MISSING", "roomName", "Room name is recommended for Foxglove/demo labels"));
  }

  const dimensionIssues = validateDimensions(room.dimensions || {});
  dimensionIssues.forEach((message) => {
    errors.push(makeValidationIssue("error", "INVALID_DIMENSION", "dimensions", message));
  });

  const objects = Array.isArray(room.objects) ? room.objects : [];
  const zones = Array.isArray(room.zones) ? room.zones : [];
  const waypoints = room.waypoints && typeof room.waypoints === "object" ? room.waypoints : {};
  const taskSequence = Array.isArray(room.taskSequence) ? room.taskSequence : [];

  const objectIds = validateDuplicateIds("objects", objects, errors);
  const zoneIds = validateDuplicateIds("zones", zones, errors);
  const waypointKeys = new Set(Object.keys(waypoints));

  if (!objects.length) {
    warnings.push(makeValidationIssue("warning", "OBJECTS_EMPTY", "objects", "add at least one robot-visible object before export"));
  }

  if (!zones.length) {
    warnings.push(makeValidationIssue("warning", "ZONES_EMPTY", "zones", "add at least one cleaning, no-go, reset, or maintenance zone before export"));
  }

  objects.forEach((item, index) => {
    if (!String(item?.label || "").trim()) {
      warnings.push(makeValidationIssue("warning", "OBJECT_LABEL_MISSING", `objects[${index}].label`, `object '${item?.id || index}' should have a readable label`));
    }
    if (!String(item?.type || "").trim()) {
      errors.push(makeValidationIssue("error", "OBJECT_TYPE_REQUIRED", `objects[${index}].type`, `object '${item?.id || index}' type is required`));
    }
    validatePoseShape(`objects[${index}].pose`, item?.pose || {}, errors);
  });

  zones.forEach((zone, index) => {
    if (!String(zone?.type || "").trim()) {
      errors.push(makeValidationIssue("error", "ZONE_TYPE_REQUIRED", `zones[${index}].type`, `zone '${zone?.id || index}' type is required`));
    }

    const bounds = Array.isArray(zone?.bounds) ? zone.bounds : [];
    if (bounds.length < 2) {
      errors.push(makeValidationIssue("error", "ZONE_BOUNDS_REQUIRED", `zones[${index}].bounds`, `zone '${zone?.id || index}' needs at least two bound points`));
    }

    bounds.forEach((point, pointIndex) => {
      if (!hasFiniteNumber(point?.x) || !hasFiniteNumber(point?.y)) {
        errors.push(makeValidationIssue(
          "error",
          "ZONE_BOUND_INVALID",
          `zones[${index}].bounds[${pointIndex}]`,
          `zone '${zone?.id || index}' bound point needs numeric x/y`
        ));
      }
    });
  });

  if (!waypointKeys.has("home")) {
    errors.push(makeValidationIssue("error", "HOME_WAYPOINT_REQUIRED", "waypoints.home", "home waypoint is required for robot start/dock"));
  }

  if (waypointKeys.size < 2) {
    warnings.push(makeValidationIssue("warning", "TARGET_WAYPOINT_MISSING", "waypoints", "add at least one target waypoint besides home before export"));
  }

  Object.entries(waypoints).forEach(([key, pose]) => {
    if (!String(key || "").trim()) {
      errors.push(makeValidationIssue("error", "WAYPOINT_KEY_REQUIRED", "waypoints", "waypoint key is required"));
    }
    validatePoseShape(`waypoints.${key}`, pose || {}, errors);
  });

  if (!taskSequence.length) {
    warnings.push(makeValidationIssue("warning", "TASK_SEQUENCE_EMPTY", "taskSequence", "add at least one task step before export"));
  }

  const validTargets = new Set([...waypointKeys, ...objectIds, ...zoneIds]);

  taskSequence.forEach((step, index) => {
    const action = String(step?.action || "").trim();
    const target = String(step?.target || "").trim();

    if (!action) {
      errors.push(makeValidationIssue("error", "TASK_ACTION_REQUIRED", `taskSequence[${index}].action`, "task action is required"));
    }

    if (!target) {
      errors.push(makeValidationIssue("error", "TASK_TARGET_REQUIRED", `taskSequence[${index}].target`, "task target is required"));
      return;
    }

    if (!validTargets.has(target)) {
      errors.push(makeValidationIssue(
        "error",
        "TASK_TARGET_MISSING",
        `taskSequence[${index}].target`,
        `target '${target}' does not exist in waypoints, objects, or zones`,
        { target, validTargets: Array.from(validTargets).sort() }
      ));
    }
  });

  const ready = errors.length === 0 && warnings.length === 0;
  const canSave = errors.length === 0;

  return {
    ready,
    canSave,
    mode,
    severity: errors.length ? "error" : warnings.length ? "warning" : "ready",
    errors,
    warnings,
    issues: [...errors, ...warnings].map(issueText),
    blockingIssues: errors.map(issueText),
  };
}

function assertRobotPlanCanSave(room, message = "Robot room has validation errors") {
  const validation = validateRobotPlan(room, { mode: "save" });
  if (!validation.canSave) {
    throw makeHttpError(422, message, validation.blockingIssues);
  }
  return validation;
}

function assertRobotPlanReadyForExport(room) {
  const validation = validateRobotPlan(room, { mode: "export" });
  if (!validation.ready) {
    throw makeHttpError(422, "Robot plan is not ready to export", validation.issues);
  }
  return validation;
}

function roomFolderPath(roomId) {
  return path.join(ROBOTICS_ROOT, "rooms", sanitizeRoomId(roomId));
}

function syncRoomJsonFiles(room) {
  const folder = roomFolderPath(room.roomId);
  ensureDir(path.join(folder, "source"));

  writeJsonFile(path.join(folder, "room_metadata.json"), {
    schemaVersion: "propertysanta.room_metadata.v1",
    roomId: room.roomId,
    propertyId: room.propertyId,
    propertyName: room.propertyName,
    roomName: room.roomName,
    source: room.source,
    sourcePhoto: room.sourcePhoto,
    dimensions: room.dimensions,
    robotHomePose: room.robotHomePose,
    photoAnnotation: room.photoAnnotation || { floorBoundary: [], annotations: [] },
    notes: room.notes,
    updatedAt: room.updatedAt,
  });

  writeJsonFile(path.join(folder, "room_objects.json"), {
    schemaVersion: "propertysanta.room_objects.v1",
    roomId: room.roomId,
    objects: room.objects || [],
  });

  writeJsonFile(path.join(folder, "room_zones.json"), {
    schemaVersion: "propertysanta.room_zones.v1",
    roomId: room.roomId,
    zones: room.zones || [],
  });

  writeJsonFile(path.join(folder, "waypoints.json"), {
    schemaVersion: "propertysanta.waypoints.v1",
    roomId: room.roomId,
    waypoints: room.waypoints || {},
  });

  writeJsonFile(path.join(folder, "robot_task_plan.json"), buildRobotTaskPlan(room));

  const readmePath = path.join(folder, "README.md");

  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(
      readmePath,
      `# ${room.roomName}\n\nGenerated by PropertySanta Robotics API.\n\n- Edit metadata through services/api /api/robotics endpoints.\n- Generate Blender scene with robotics/tools/generate_room_scene.py.\n- Run ROS2/Foxglove simulation from robotics_ws.\n`
    );
  }
}

function persistRoom(room) {
  const store = readStore();
  const index = findRoomIndex(store, room.roomId);
  const nextRoom = { ...room, updatedAt: new Date().toISOString() };

  if (index >= 0) store.rooms[index] = nextRoom;
  else store.rooms.push(nextRoom);

  writeStore(store);
  syncRoomJsonFiles(nextRoom);

  return nextRoom;
}

function roomSummary(room) {
  const validation = validateRobotPlan(room);

  return {
    roomId: room.roomId,
    propertyName: room.propertyName,
    roomName: room.roomName,
    dimensions: room.dimensions,
    designPackage: room.designPackage || null,
    estimatedCleaningMinutes: room.estimatedCleaningMinutes || room.designPackage?.predictedCleaningMinutes || 0,
    counts: {
      objects: (room.objects || []).length,
      zones: (room.zones || []).length,
      waypoints: Object.keys(room.waypoints || {}).length,
      taskSteps: (room.taskSequence || []).length,
      inspectionTasks: (room.maintenanceInspectionTasks || []).length,
    },
    readyForExport: validation.ready,
    canSave: validation.canSave,
    validationSeverity: validation.severity,
    validationIssues: validation.issues,
    validationErrors: validation.errors,
    validationWarnings: validation.warnings,
    updatedAt: room.updatedAt,
  };
}

function sendError(res, error) {
  res.status(error.status || 500).json({
    ok: false,
    message: error.message || "Robotics API error",
    details: error.details || undefined,
  });
}

function decodeImageDataUrl(imageDataUrl = "") {
  const match = String(imageDataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  const mime = match[1];
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";

  return {
    ext,
    buffer: Buffer.from(match[2], "base64"),
  };
}

function repoRoot() {
  return path.resolve(__dirname, "../../..");
}

function roomDirFor(roomId) {
  return path.join(repoRoot(), "robotics", "rooms", sanitizeRoomId(roomId));
}

function pickPythonBin(root) {
  if (process.env.ROBOTICS_PYTHON) return process.env.ROBOTICS_PYTHON;

  const candidates = process.platform === "win32"
    ? [
      path.join(root, ".venv_photo_win", "Scripts", "python.exe"),
      path.join(root, ".venv_photo", "Scripts", "python.exe"),
      "python",
      "py",
    ]
    : [
      path.join(root, ".venv_photo", "bin", "python"),
      "python3",
      "python",
    ];

  return candidates.find((candidate) => !candidate.includes(path.sep) || fs.existsSync(candidate)) || candidates[0];
}

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "PropertySanta Robotics API online",
    phase: "Phase 2 - backend API + JSON data model",
    stack: ["Node API", "JSON task plans", "Blender/Python tools", "ROS2 Jazzy", "Foxglove"],
    topics: FOXGLOVE_TOPICS,
    timestamp: new Date().toISOString(),
  });
});

router.get("/rooms", (req, res) => {
  const store = readStore();

  res.json({
    ok: true,
    rooms: store.rooms.map(roomSummary),
  });
});

router.post("/rooms", (req, res) => {
  try {
    const store = readStore();
    const roomId = sanitizeRoomId(req.body?.roomId || req.body?.id);
    const existing = store.rooms.find((item) => item.roomId === roomId) || null;
    const room = normalizeRoom({ ...req.body, roomId }, existing);
    assertRobotPlanCanSave(room, "Robot room has validation errors. Fix the red items before saving this plan.");
    const dimensionIssues = validateDimensions(room.dimensions);

    if (dimensionIssues.length) {
      throw makeHttpError(422, "Room dimensions are required before saving a robot-ready room", dimensionIssues);
    }

    const savedRoom = persistRoom(room);

    res.status(existing ? 200 : 201).json({
      ok: true,
      room: savedRoom,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/rooms/:roomId", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    res.json({ ok: true, room, summary: roomSummary(room) });
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/rooms/:roomId", (req, res) => {
  try {
    const { room: existing } = getRoomOrThrow(req.params.roomId);
    const room = normalizeRoom({ ...req.body, roomId: existing.roomId }, existing);
    assertRobotPlanCanSave(room, "Robot room has validation errors. Fix the red items before saving this plan.");
    const dimensionIssues = validateDimensions(room.dimensions);

    if (dimensionIssues.length) {
      throw makeHttpError(422, "Room dimensions are required before saving a robot-ready room", dimensionIssues);
    }

    const savedRoom = persistRoom(room);

    res.json({
      ok: true,
      room: savedRoom,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/rooms/:roomId/objects", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    const nextObjects = Array.isArray(req.body?.objects)
      ? req.body.objects.map(normalizeRobotObject)
      : upsertById(room.objects, normalizeRobotObject(req.body));

    const nextRoom = { ...room, objects: nextObjects };
    assertRobotPlanCanSave(nextRoom, "Object save blocked because the robot plan has validation errors.");
    const savedRoom = persistRoom(nextRoom);

    res.json({
      ok: true,
      objects: savedRoom.objects,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/rooms/:roomId/zones", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    const nextZones = Array.isArray(req.body?.zones)
      ? req.body.zones.map(normalizeZone)
      : upsertById(room.zones, normalizeZone(req.body));

    const nextRoom = { ...room, zones: nextZones };
    assertRobotPlanCanSave(nextRoom, "Zone save blocked because the robot plan has validation errors.");
    const savedRoom = persistRoom(nextRoom);

    res.json({
      ok: true,
      zones: savedRoom.zones,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/rooms/:roomId/waypoints", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    let nextWaypoints = { ...(room.waypoints || {}) };

    if (req.body?.replace === true) nextWaypoints = {};

    if (req.body?.waypoints && typeof req.body.waypoints === "object") {
      nextWaypoints = { ...nextWaypoints, ...normalizeWaypointMap(req.body.waypoints) };
    } else {
      const waypoint = normalizeWaypoint(req.body?.key || req.body?.id, req.body || {});
      nextWaypoints[waypoint.key] = waypoint.pose;
    }

    const nextRoom = { ...room, waypoints: nextWaypoints };
    assertRobotPlanCanSave(nextRoom, "Waypoint save blocked because the robot plan has validation errors.");
    const savedRoom = persistRoom(nextRoom);

    res.json({
      ok: true,
      waypoints: savedRoom.waypoints,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/rooms/:roomId/tasks", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    const incomingSteps = Array.isArray(req.body?.taskSequence)
      ? req.body.taskSequence
      : Array.isArray(req.body?.steps)
        ? req.body.steps
        : [req.body];

    const normalizedSteps = incomingSteps.map(normalizeTaskStep);
    const nextTaskSequence = req.body?.replace === false
      ? [...(room.taskSequence || []), ...normalizedSteps].map(normalizeTaskStep)
      : normalizedSteps.map(normalizeTaskStep);

    const nextRoom = { ...room, taskSequence: nextTaskSequence };
    assertRobotPlanCanSave(nextRoom, "Task save blocked: one or more task targets are missing from waypoints, objects, or zones.");
    const savedRoom = persistRoom(nextRoom);

    res.json({
      ok: true,
      taskSequence: savedRoom.taskSequence,
      summary: roomSummary(savedRoom),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/rooms/:roomId/validate", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    const validation = validateRobotPlan(room, { mode: "export" });

    res.json({
      ok: true,
      roomId: room.roomId,
      readyForExport: validation.ready,
      canSave: validation.canSave,
      validation,
      summary: roomSummary(room),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/rooms/:roomId/export-plan", (req, res) => {
  try {
    const { room } = getRoomOrThrow(req.params.roomId);
    const validation = validateRobotPlan(room);

    if (!validation.ready) {
      throw makeHttpError(422, "Robot plan is not ready to export", validation.issues);
    }
    assertRobotPlanReadyForExport(room);

    const plan = buildRobotTaskPlan(room);
    syncRoomJsonFiles(room);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${room.roomId}_robot_task_plan.json"`);
    res.status(200).send(JSON.stringify(plan, null, 2));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/rooms/:roomId/analyze-photo", (req, res) => {
  try {
    const roomId = sanitizeRoomId(req.params.roomId);
    const { room } = getRoomOrThrow(roomId);

    const decoded = decodeImageDataUrl(req.body?.imageDataUrl);
    if (!decoded) {
      return res.status(400).json({
        ok: false,
        message: "Missing imageDataUrl. Upload a photo in Photo annotation first.",
      });
    }

    const root = repoRoot();
    const roomDir = roomDirFor(roomId);
    const sourceDir = path.join(roomDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });

    const imagePath = path.join(sourceDir, `auto_analyzer_input.${decoded.ext}`);
    fs.writeFileSync(imagePath, decoded.buffer);

    const analyzerRoom = normalizeRoom({
      ...room,
      roomId: room.roomId,
      dimensions: req.body?.dimensions || room.dimensions,
      sourcePhoto: path.relative(roomDir, imagePath).replace(/\\/g, "/"),
      photoAnnotation: {
        ...(room.photoAnnotation || {}),
        roomId: room.roomId,
        mapping: "homography_v1",
        updatedAt: new Date().toISOString(),
        floorBoundary: Array.isArray(req.body?.floorBoundary)
          ? req.body.floorBoundary
          : room.photoAnnotation?.floorBoundary || [],
        annotations: room.photoAnnotation?.annotations || [],
      },
    }, room);

    // Python analyzer ke liye latest dimensions/floorBoundary JSON me sync karo.
    syncRoomJsonFiles(analyzerRoom);

    const scriptPath = path.join(root, "robotics", "tools", "analyze_room_photo.py");
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({
        ok: false,
        message: "Photo analyzer script not found",
        scriptPath,
      });
    }

    const args = [scriptPath, roomDir, "--image", imagePath];
    if (req.body?.useFlorence === true) args.push("--florence");

    const pythonBin = pickPythonBin(root);
    const command = pythonBin === "py" ? "py" : pythonBin;
    const finalArgs = pythonBin === "py" ? ["-3", ...args] : args;

    const result = spawnSync(command, finalArgs, {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 12,
      shell: false,
    });

    if (result.error) {
      console.error("[robotics-analyzer] spawn error", {
        pythonBin,
        message: result.error.message,
      });

      return res.status(500).json({
        ok: false,
        message: result.error.message,
        pythonBin,
        hint: process.platform === "win32"
          ? "Backend is running on Windows. Create C:\\dev\\ai-property-app\\.venv_photo_win or set ROBOTICS_PYTHON to a Windows python.exe."
          : "Backend is running in WSL/Linux. Create .venv_photo or set ROBOTICS_PYTHON to .venv_photo/bin/python.",
      });
    }

    if (result.status !== 0) {
      console.error("[robotics-analyzer] script failed", {
        pythonBin,
        exitCode: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      });

      return res.status(500).json({
        ok: false,
        message: "Photo analyzer failed",
        pythonBin,
        exitCode: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }

    const analysisPath = path.join(roomDir, "photo_analysis.json");
    if (!fs.existsSync(analysisPath)) {
      return res.status(500).json({
        ok: false,
        message: "Photo analyzer finished but photo_analysis.json was not created",
        analysisPath,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));

    return res.json({
      ok: true,
      roomId,
      analysis,
      stdout: result.stdout,
    });
  } catch (err) {
    console.error("[robotics-analyzer] route failed", err);
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Photo analyzer failed",
      details: err.details || undefined,
    });
  }
});

module.exports = router;
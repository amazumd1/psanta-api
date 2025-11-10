// api/controller.js

const Property = require('../models/Property');
const mongoose = require('mongoose');

/**
 * Get all properties
 */
const getAllProperties = async (req, res) => {
  try {
    const properties = await Property.find({}).sort({ createdAt: -1 }).populate('customer', 'name email');
    res.json({ success: true, properties });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching properties', error: error.message });
  }
};

/**
 * Get property by ID
 */
const getPropertyById = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id).populate('customer', 'name email');
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    res.json({ success: true, property });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching property', error: error.message });
  }
};

/**
 * Create new property
 */
const createProperty = async (req, res) => {
  try {
    const { propertyId, name, address, city, state, zip, type, squareFootage, roomTasks, customer, cycle, isActive } = req.body;


    // Validate required fields
    if (!propertyId || !name || !address || !type || squareFootage === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields. Required: propertyId, name, address, type, squareFootage'
      });
    }

    // Check for existing property
    const existingProperty = await Property.findOne({ propertyId });
    if (existingProperty) {
      return res.status(400).json({
        success: false,
        message: 'Property ID already exists'
      });
    }

    // Create property with all required fields
    const property = new Property({
      propertyId,
      name,
      address,
      city: city || '',
      state: state || '',
      zip: zip || '',
      type,
      squareFootage: Number(squareFootage) || 0,
      roomTasks: Array.isArray(roomTasks) ? roomTasks : [],
      customer: customer || null,
      cycle: cycle || null,
      manual: {
        title: 'Live Cleaning & Maintenance Manual',
        content: `Live Cleaning & Maintenance Manual\n${address}\nProperty Overview\n- Property ID: ${propertyId}\n- Type: ${type}\n- Square Footage: ${squareFootage} sq ft`
      }
    });

    const savedProperty = await property.save();
    res.status(201).json({ success: true, property: savedProperty });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating property', error: error.message });
  }
};

/**
 * Update property
 */
const updateProperty = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    Object.keys(req.body).forEach(key => {
      if (key !== '_id' && key !== '__v') property[key] = req.body[key];
    });
    const allowed = ['name', 'propertyId', 'address', 'city', 'state', 'zip', 'type', 'squareFootage', 'cycle', 'isActive', 'roomTasks', 'manual', 'customer'];
    for (const key of allowed) {
      if (key in req.body) property[key] = req.body[key];
    }


    // Validate customer ObjectId if updated
    // if (req.body.customer && !mongoose.Types.ObjectId.isValid(req.body.customer)) {
    //   return res.status(400).json({ success: false, message: 'Invalid customer ID' });
    // }

    const updatedProperty = await property.save();
    res.json({ success: true, property: updatedProperty });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating property', error: error.message });
  }
};

/**
 * Delete property
 */
const deleteProperty = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    await Property.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Property deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting property', error: error.message });
  }
};

/**
 * Get property manual
 */
const getPropertyManual = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    res.json({ success: true, manual: property.manual });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching property manual', error: error.message });
  }
};

/**
 * Update property manual
 */
const updatePropertyManual = async (req, res) => {
  try {
    const { manual } = req.body;
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    if (!manual || !manual.title || !manual.content) {
      return res.status(400).json({ success: false, message: 'Manual title and content are required' });
    }

    property.manual = { title: manual.title, content: manual.content, lastUpdated: new Date() };
    const updatedProperty = await property.save();
    res.json({ success: true, property: updatedProperty });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating property manual', error: error.message });
  }
};

/**
 * Toggle property active status
 */
const togglePropertyStatus = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    property.isActive = !property.isActive;
    const updatedProperty = await property.save();
    res.json({ success: true, property: updatedProperty });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error toggling property status', error: error.message });
  }
};

/**
 * Update roomTask status
 */
const updateRoomTaskStatus = async (req, res) => {
  try {
    const { propertyId, roomType, taskIndex } = req.params;
    const { isCompleted } = req.body;
    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    const roomTask = property.roomTasks.find(rt => rt.roomType === roomType);
    if (!roomTask || !roomTask.tasks[taskIndex]) return res.status(404).json({ success: false, message: 'Room task not found' });

    roomTask.tasks[taskIndex].isCompleted = isCompleted;
    await property.save();
    res.json({ success: true, message: 'Room task status updated', data: property });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

/**
 * Update notes for a roomTask
 */
const updateRoomTaskNotes = async (req, res) => {
  try {
    const { propertyId, roomType } = req.params;
    const { notes } = req.body;
    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    const roomTask = property.roomTasks.find(rt => rt.roomType === roomType);
    if (!roomTask) return res.status(404).json({ success: false, message: 'Room task not found' });

    roomTask.notes = notes;
    await property.save();
    res.json({ success: true, message: 'Notes updated', data: property });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

/**
 * Get stats for all properties/roomTasks
 */
const getPropertyStats = async (req, res) => {
  try {
    const properties = await Property.find({});
    let totalTasks = 0, completedTasks = 0;

    properties.forEach(property => {
      property.roomTasks.forEach(rt => {
        totalTasks += rt.tasks.length;
        completedTasks += rt.tasks.filter(t => t.isCompleted).length;
      });
    });

    res.json({
      success: true,
      data: {
        totalTasks,
        completedTasks,
        completionRate: totalTasks > 0 ? (completedTasks / totalTasks * 100).toFixed(1) : 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

module.exports = {
  getAllProperties,
  getPropertyById,
  createProperty,
  updateProperty,
  deleteProperty,
  getPropertyManual,
  updatePropertyManual,
  togglePropertyStatus,
  updateRoomTaskStatus,
  updateRoomTaskNotes,
  getPropertyStats
};

const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');

// Properties
router.get('/', propertyController.getAllProperties);
router.get('/:id', propertyController.getPropertyById);
router.post('/', propertyController.createProperty);
router.put('/:id', propertyController.updateProperty);
router.delete('/:id', propertyController.deleteProperty);

// Property manual
router.get('/:id/manual', propertyController.getPropertyManual);
router.patch('/:id/manual', propertyController.updatePropertyManual);

// Toggle status
router.patch('/:id/toggle-status', propertyController.togglePropertyStatus);

// Room task updates
router.patch('/:propertyId/room-tasks/:roomType/:taskIndex/status', propertyController.updateRoomTaskStatus);
router.patch('/:propertyId/room-tasks/:roomType/notes', propertyController.updateRoomTaskNotes);

// Stats
router.get('/stats', propertyController.getPropertyStats);

module.exports = router;

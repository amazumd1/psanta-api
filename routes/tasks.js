const express = require('express');
const router = express.Router();
const {
  createTask,
  getTasks,
  getTask,
  updateTask,
  deleteTask,
  addPhoto,
  addIssue,
  updateRequirementStatus
} = require('../controllers/taskController');

// Routes for task management
router
  .route('/')
  .get(getTasks)
  .post(createTask);

router
  .route('/:id')
  .get(getTask)
  .put(updateTask)
  .delete(deleteTask);

// Photo and issue routes
router.post('/:id/photos', addPhoto);
router.post('/:id/issues', addIssue);

// Task requirement status update
router.put(
  '/:taskId/requirements/:reqIndex/tasks/:taskIndex',
  updateRequirementStatus
);

module.exports = router;
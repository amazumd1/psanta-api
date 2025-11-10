const Task = require('../models/Task');
const mongoose = require('mongoose');

// @desc    Create a new task
// @route   POST /api/tasks
// @access  Private/Admin
exports.createTask = async (req, res) => {
  try {
    const { propertyId, requirements, specialRequirement, scheduledTime, assignedTo } = req.body;
    
    const task = new Task({
      propertyId,
      requirements: requirements || [],
      specialRequirement,
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
      assignedTo,
      isActive: true
    });

    await task.save();
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Get all tasks
// @route   GET /api/tasks
// @access  Private/Admin
exports.getTasks = async (req, res) => {
  try {
    const { propertyId, isActive, assignedTo } = req.query;
    const filter = {};
    
    if (propertyId) filter.propertyId = propertyId;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (assignedTo) filter.assignedTo = assignedTo;
    
    const tasks = await Task.find(filter)
      .sort({ scheduledTime: -1 });
      
    res.status(200).json({ success: true, count: tasks.length, data: tasks });
  } catch (error) {
    console.error('Error getting tasks:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Get single task by ID
// @route   GET /api/tasks/:id
// @access  Private
exports.getTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('assignedTo', 'name email');
      
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    console.error('Error getting task:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Update task
// @route   PUT /api/tasks/:id
// @access  Private/Admin
exports.updateTask = async (req, res) => {
  try {
    const { requirements, specialRequirement, scheduledTime, assignedTo, isActive } = req.body;
    
    const task = await Task.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          requirements,
          specialRequirement,
          scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
          assignedTo,
          isActive
        }
      },
      { new: true, runValidators: true }
    );
    
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Delete task
// @route   DELETE /api/tasks/:id
// @access  Private/Admin
exports.deleteTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Add photo to task
// @route   POST /api/tasks/:id/photos
// @access  Private
exports.addPhoto = async (req, res) => {
  try {
    const { url, type, tags, notes } = req.body;
    
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    const photo = {
      url,
      type,
      uploadedBy: req.user.id,
      tags,
      notes
    };
    
    task.photos.push(photo);
    await task.save();
    
    res.status(201).json({ 
      success: true, 
      data: task.photos[task.photos.length - 1] 
    });
  } catch (error) {
    console.error('Error adding photo:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Add issue to task
// @route   POST /api/tasks/:id/issues
// @access  Private
exports.addIssue = async (req, res) => {
  try {
    const { type, description, location, notes, photoId } = req.body;
    
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    const issue = {
      type,
      description,
      location,
      notes,
      photoId,
      reportedBy: req.user.id,
      isResolved: false
    };
    
    task.issues.push(issue);
    await task.save();
    
    res.status(201).json({ 
      success: true, 
      data: task.issues[task.issues.length - 1] 
    });
  } catch (error) {
    console.error('Error adding issue:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Update task requirement status
// @route   PUT /api/tasks/:taskId/requirements/:reqIndex/tasks/:taskIndex
// @access  Private
exports.updateRequirementStatus = async (req, res) => {
  try {
    const { taskId, reqIndex, taskIndex } = req.params;
    const { isCompleted } = req.body;
    
    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    if (reqIndex >= task.requirements.length) {
      return res.status(400).json({ success: false, error: 'Invalid requirement index' });
    }
    
    const requirement = task.requirements[reqIndex];
    
    if (taskIndex >= requirement.tasks.length) {
      return res.status(400).json({ success: false, error: 'Invalid task index' });
    }
    
    requirement.tasks[taskIndex].isCompleted = isCompleted;
    
    // Check if all tasks in this requirement are completed
    const allTasksCompleted = requirement.tasks.every(task => task.isCompleted);
    requirement.isCompleted = allTasksCompleted;
    
    await task.save();
    
    res.status(200).json({ 
      success: true, 
      data: requirement 
    });
  } catch (error) {
    console.error('Error updating requirement status:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};
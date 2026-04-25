const Property = require('../models/Property');
const Task = require('../models/Task');
const geminiService = require('../services/geminiService');
const scoringService = require('../services/scoringService');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeAddonList(addons) {
  if (Array.isArray(addons)) {
    return addons.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (addons && typeof addons === 'object') {
    return Object.entries(addons)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => String(key || '').trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSchedule(schedule) {
  return asArray(schedule)
    .map((slot) => ({
      date: String(slot?.date || '').trim(),
      time: String(slot?.time || '10:00').trim() || '10:00',
    }))
    .filter((slot) => slot.date);
}

function buildFallbackBookingBrief(payload = {}) {
  const addonList = normalizeAddonList(payload.addons);
  const schedule = normalizeSchedule(payload.schedule);
  const firstStop = schedule[0] || null;
  const visitWord = schedule.length === 1 ? 'visit' : 'visits';
  const sizeBits = [
    Number(payload.beds) > 0 ? `${Number(payload.beds)} bed` : null,
    Number(payload.baths) > 0 ? `${Number(payload.baths)} bath` : null,
    Number(payload.sqft) > 0 ? `${Number(payload.sqft)} sqft` : null,
  ].filter(Boolean);

  const summaryParts = [
    `${String(payload.serviceType || 'standard').replace(/_/g, ' ')} cleaning`,
    sizeBits.length ? `for ${sizeBits.join(' / ')}` : null,
    payload.condition ? `condition: ${payload.condition}` : null,
    schedule.length ? `${schedule.length} scheduled ${visitWord}` : 'schedule pending',
    firstStop ? `first arrival ${firstStop.date} at ${firstStop.time}` : null,
    Number(payload.aiMinutes) > 0 ? `estimated onsite time ${Number(payload.aiMinutes)} mins` : null,
    payload.maintenanceLabel && payload.maintenanceLabel !== 'No maintenance add-on'
      ? `maintenance attached: ${payload.maintenanceLabel}`
      : null,
  ].filter(Boolean);

  const cleanerChecklist = [
    payload.serviceType === 'deep'
      ? 'Start with kitchen and bathrooms, then detail high-touch surfaces, baseboards, and visible edges.'
      : 'Follow the standard room reset flow: kitchen, bathrooms, living areas, bedrooms, then final walkthrough.',
    addonList.length
      ? `Complete selected add-ons: ${addonList.join(', ')}.`
      : 'No special add-ons selected on this booking.',
    schedule.length > 1
      ? `Treat this as a multi-visit plan. Keep notes consistent across all ${schedule.length} visits.`
      : 'Close the visit with a quick final reset note for Ops.',
    'Capture arrival, progress, and completion notes if something blocks the clean.',
  ];

  const roomFocus = [
    payload.serviceType === 'deep'
      ? 'Kitchen: appliance fronts, backsplash, sink detail, cabinet touchpoints.'
      : 'Kitchen: counters, sink, appliance exterior, trash reset.',
    'Bathrooms: mirrors, sink, toilet, shower/tub surfaces, floor edges.',
    'Living + bedrooms: dust reachable surfaces, reset floors, straighten visible presentation areas.',
    addonList.includes('pet')
      ? 'Pet areas: hair pickup, odor check, and visible surface wipe-down.'
      : 'Entry + touchpoints: handles, switches, and obvious fingerprint zones.',
  ];

  const opsNotes = [
    payload.maintenanceLabel && payload.maintenanceLabel !== 'No maintenance add-on'
      ? `Ops should attach ${payload.maintenanceLabel} instructions to the cleaner packet.`
      : 'No maintenance add-on was selected for this booking.',
    payload.packId
      ? `This booking is tied to plan ${payload.packId}; keep the first visit quality bar high because it anchors future visits.`
      : 'Pay-as-you-go booking; no recurring plan bundle selected.',
    Number(payload.checkoutTotal) > 0
      ? `Customer checkout total captured at $${Number(payload.checkoutTotal).toFixed(2)}.`
      : 'Checkout total not provided in the request payload.',
  ];

  return {
    source: 'fallback',
    summary: summaryParts.join(' · '),
    cleanerChecklist,
    roomFocus,
    opsNotes,
  };
}

// Helper to get manual requirements for a room
const getManualRequirementsForRoom = (property, roomType) => {
  if (!property || !property.roomTasks) return '';
  const roomTask = property.roomTasks.find(rt => rt.roomType === roomType);
  if (!roomTask) return '';
  let manualRequirements = roomTask.tasks.map(task =>
    `${task.description} (${task.estimatedTime})${task.specialNotes ? ` - ${task.specialNotes}` : ''}`
  ).join('\n');
  if (roomTask.specialInstructions.length > 0) {
    manualRequirements += `\nSpecial Instructions: ${roomTask.specialInstructions.join(', ')}`;
  }
  if (roomTask.fragileItems.length > 0) {
    manualRequirements += `\nFragile Items: ${roomTask.fragileItems.join(', ')}`;
  }
  return manualRequirements;
};

// -------------------- Controllers -------------------- //

// Chat with AI
const chatWithAI = async (req, res) => {
  try {
    const { message, propertyId, roomType, completedTasks, manualTips, taskId, skipChatHistory } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message is required' });

    // Get the task ID - either from request body or find it from propertyId
    let currentTaskId = taskId;
    if (!currentTaskId && propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) {
        currentTaskId = task._id.toString();
      }
    }

    geminiService.updateContext({
      currentRoom: roomType,
      completedTasks: completedTasks || [],
      manualTips: manualTips || []
    }, currentTaskId);

    if (currentTaskId) {
      const task = await Task.findById(currentTaskId);
      console.log(task, '------task-----------------')
      if (task) {
        // Check if task has chat history and restore context
        if (task.chatHistory && task.chatHistory.length > 0) {
          console.log(`Restoring context from chat history for task: ${currentTaskId}`);
          await geminiService.restoreContextFromHistory(currentTaskId);
        } else {
          // New task, set initial context
          geminiService.updateContext({
            currentProperty: task,
            workflowState: geminiService.getContext(currentTaskId).workflowState || 'initial'
          }, currentTaskId);
        }
      }
    }

    const aiResponse = await geminiService.generateChatResponse(message, currentTaskId);
    const context = geminiService.getContext(currentTaskId);

    // Save chat history to task (skip if flag is set)
    if (currentTaskId && !skipChatHistory) {
      try {
        const task = await Task.findById(currentTaskId);
        if (task) {
          // Add user message and AI response to chat history
          const chatMessages = [
            {
              message: message,
              sender: 'user',
              timestamp: new Date(),
              type: 'text'
            },
            {
              message: aiResponse,
              sender: 'system',
              timestamp: new Date(),
              type: 'text'
            }
          ];

          await Task.findByIdAndUpdate(
            currentTaskId,
            {
              $push: {
                chatHistory: { $each: chatMessages }
              }
            },
            { new: true }
          );
        }
      } catch (error) {
        console.error('Error saving chat history:', error);
        // Continue even if save fails - don't break the user flow
      }
    }

    res.json({
      success: true,
      data: {
        message: aiResponse,
        timestamp: new Date().toISOString(),
        workflowState: context.workflowState,
        beforePhotosLogged: context.beforePhotosLogged,
        afterPhotosLogged: context.afterPhotosLogged,
        currentRoom: context.currentRoom,
        chatHistoryLength: context.chatHistory.length
      }
    });
  } catch (error) {
    console.error('AI chat error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate AI response' });
  }
};

// Handle photo upload
const handlePhotoUpload = async (req, res) => {
  try {
    const { photoBase64, photoType, roomType, propertyId, userMessage, taskId } = req.body;
    if (!photoBase64) return res.status(400).json({ success: false, message: 'Photo data is required' });
    if (!photoType || !roomType) return res.status(400).json({ success: false, message: 'Photo type and room type are required' });

    // Get the task ID - either from request body or find it from propertyId
    let currentTaskId = taskId;
    if (!currentTaskId && propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) {
        currentTaskId = task._id.toString();
      }
    }

    if (currentTaskId) {
      const task = await Task.findById(currentTaskId);
      if (task) geminiService.updateContext({ currentProperty: task }, currentTaskId);
    }

    const result = await geminiService.handlePhotoUpload(photoBase64, photoType, roomType, userMessage, currentTaskId);
    const context = geminiService.getContext(currentTaskId);

    // Save photo upload to chat history
    if (currentTaskId) {
      try {
        const task = await Task.findById(currentTaskId);
        if (task) {
          const chatMessage = {
            message: `Uploaded ${photoType} photo for ${roomType}`,
            sender: 'user',
            timestamp: new Date(),
            type: 'photo'
          };

          await Task.findByIdAndUpdate(
            currentTaskId,
            {
              $push: {
                chatHistory: chatMessage
              }
            },
            { new: true }
          );
        }
      } catch (error) {
        console.error('Error saving photo upload to chat history:', error);
        // Continue even if save fails
      }
    }

    res.json({ success: true, data: { ...result, workflowState: context.workflowState } });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to process photo upload' });
  }
};

// Score before/after photos
const scoreBeforeAfterPhotos = async (req, res) => {
  try {
    const { beforePhotoBase64, afterPhotoBase64, roomType, propertyId, taskId } = req.body;
    if (!beforePhotoBase64 || !afterPhotoBase64) return res.status(400).json({ success: false, message: 'Both before and after photos are required' });
    if (!taskId) return res.status(400).json({ success: false, message: 'Task ID is required for scoring' });

    const scoringResult = await scoringService.scoreBeforeAfterPhotos(beforePhotoBase64, afterPhotoBase64, roomType, propertyId, taskId);
    if (!scoringResult.success) return res.status(500).json({ success: false, message: scoringResult.error });

    res.json({ success: true, data: scoringResult.data });
  } catch (error) {
    console.error('Scoring error:', error);
    res.status(500).json({ success: false, message: 'Failed to score photos' });
  }
};

// Analyze before/after photos
const analyzeBeforeAfterPhotos = async (req, res) => {
  try {
    const { beforePhotoBase64, afterPhotoBase64, roomType, propertyId, taskId } = req.body;
    if (!beforePhotoBase64 || !afterPhotoBase64) return res.status(400).json({ success: false, message: 'Both before and after photos are required' });

    let manualRequirements = '';
    let currentTaskId = taskId;

    if (!currentTaskId && propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) {
        currentTaskId = task._id.toString();
      }
    }

    if (currentTaskId) {
      const task = await Task.findById(currentTaskId);
      if (task) {
        geminiService.updateContext({ currentProperty: task }, currentTaskId);
        // Get requirements from task, not property
        const taskRequirements = task.requirements.find(rt => rt.roomType.toLowerCase() === roomType.toLowerCase());
        if (taskRequirements) {
          manualRequirements = taskRequirements.tasks.map(task => `- ${task.description}`).join('\n');
        }
      }
    }

    const analysis = await geminiService.analyzeBeforeAfterComparison(beforePhotoBase64, afterPhotoBase64, roomType, manualRequirements, currentTaskId);

    // Save AI analysis response to chat history
    if (currentTaskId && analysis.message) {
      try {
        const task = await Task.findById(currentTaskId);
        if (task) {
          const chatMessage = {
            message: analysis.message,
            sender: 'system',
            timestamp: new Date(),
            type: 'text'
          };

          await Task.findByIdAndUpdate(
            currentTaskId,
            {
              $push: {
                chatHistory: chatMessage
              }
            },
            { new: true }
          );
        }
      } catch (error) {
        console.error('Error saving analysis to chat history:', error);
        // Continue even if save fails
      }
    }

    res.json({ success: true, data: analysis });
  } catch (error) {
    console.error('Before/After analysis error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze before/after photos' });
  }
};

// Analyze single photo with manual requirements
const analyzePhotoWithManual = async (req, res) => {
  try {
    const { photoBase64, photoType, roomType, propertyId, taskId } = req.body;
    if (!photoBase64) return res.status(400).json({ success: false, message: 'Photo data is required' });

    let manualRequirements = '';
    let currentTaskId = taskId;

    if (!currentTaskId && propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) {
        currentTaskId = task._id.toString();
      }
    }

    if (currentTaskId) {
      const task = await Task.findById(currentTaskId);
      if (task) {
        geminiService.updateContext({ currentProperty: task }, currentTaskId);
        // Get requirements from task, not property
        const taskRequirements = task.requirements.find(rt => rt.roomType.toLowerCase() === roomType.toLowerCase());
        if (taskRequirements) {
          manualRequirements = taskRequirements.tasks.map(task => `- ${task.description}`).join('\n');
        }
      }
    }

    const analysis = await geminiService.analyzePhotoWithManual(photoBase64, photoType, roomType, manualRequirements);

    // Save AI analysis response to chat history
    if (currentTaskId && analysis.message) {
      try {
        const task = await Task.findById(currentTaskId);
        if (task) {
          const chatMessage = {
            message: analysis.message,
            sender: 'system',
            timestamp: new Date(),
            type: 'text'
          };

          await Task.findByIdAndUpdate(
            currentTaskId,
            {
              $push: {
                chatHistory: chatMessage
              }
            },
            { new: true }
          );
        }
      } catch (error) {
        console.error('Error saving analysis to chat history:', error);
        // Continue even if save fails
      }
    }

    res.json({ success: true, data: analysis });
  } catch (error) {
    console.error('Photo analysis error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze photo' });
  }
};

// Generate workflow guidance
const generateWorkflowGuidance = async (req, res) => {
  try {
    const { roomType, propertyId, currentProgress } = req.body;
    if (!roomType) return res.status(400).json({ success: false, message: 'Room type is required' });

    const guidance = await scoringService.generateWorkflowGuidance(roomType, propertyId, currentProgress || 'Starting');
    if (!guidance.success) return res.status(500).json({ success: false, message: guidance.error });

    res.json({ success: true, data: guidance.data });
  } catch (error) {
    console.error('Workflow guidance error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate workflow guidance' });
  }
};

// Get workflow state
const getWorkflowState = async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) {
      return res.status(400).json({ success: false, message: 'Task ID is required' });
    }

    const context = geminiService.getContext(taskId);
    res.json({
      success: true,
      data: {
        workflowState: context.workflowState,
        beforePhotosLogged: context.beforePhotosLogged,
        afterPhotosLogged: context.afterPhotosLogged,
        currentRoomIndex: context.currentRoomIndex,
        chatHistory: (context.chatHistory || []).slice(-10)
      }
    });
  } catch (error) {
    console.error('Get workflow state error:', error);
    res.status(500).json({ success: false, message: 'Failed to get workflow state' });
  }
};

// Get chat history for a task
const getChatHistory = async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ success: false, message: 'Task ID is required' });
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    res.json({
      success: true,
      data: {
        chatHistory: task.chatHistory || []
      }
    });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({ success: false, message: 'Failed to get chat history' });
  }
};

// Save a single chat message to task history
const saveChatMessage = async (taskId, messageData) => {
  try {
    if (!taskId) return;

    const chatMessage = {
      message: messageData.message,
      sender: messageData.sender,
      timestamp: new Date(),
      type: messageData.type || 'text',
      isCommand: messageData.isCommand || false,
      commandType: messageData.commandType,
      data: messageData.data,
      imageUrl: messageData.imageUrl,
      imageType: messageData.imageType,
      roomType: messageData.roomType
    };

    await Task.findByIdAndUpdate(
      taskId,
      {
        $push: {
          chatHistory: chatMessage
        }
      },
      { new: true }
    );

    console.log(`Saved chat message to task ${taskId}:`, messageData.type, messageData.message.substring(0, 50));
  } catch (error) {
    console.error('Error saving chat message:', error);
    // Continue even if save fails - don't break the user flow
  }
};

// API endpoint to save a single chat message
const saveChatMessageAPI = async (req, res) => {
  try {
    const { taskId, message, sender, type, isCommand, commandType, data, imageUrl, imageType, roomType } = req.body;

    if (!taskId || !message || !sender) {
      return res.status(400).json({ success: false, message: 'Task ID, message, and sender are required' });
    }

    await saveChatMessage(taskId, {
      message,
      sender,
      type,
      isCommand,
      commandType,
      data,
      imageUrl,
      imageType,
      roomType
    });

    res.json({ success: true, message: 'Chat message saved successfully' });
  } catch (error) {
    console.error('Save chat message API error:', error);
    res.status(500).json({ success: false, message: 'Failed to save chat message' });
  }
};

// Reset workflow
const resetWorkflow = async (req, res) => {
  try {
    const { propertyId, taskId } = req.body;

    // Get the task ID - either from request body or find it from propertyId
    let currentTaskId = taskId;
    if (!currentTaskId && propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) {
        currentTaskId = task._id.toString();
      }
    }

    if (!currentTaskId) {
      return res.status(400).json({ success: false, message: 'Task ID or Property ID is required' });
    }

    geminiService.updateContext({
      workflowState: 'initial',
      beforePhotosLogged: [],
      afterPhotosLogged: [],
      currentRoomIndex: 0,
      chatHistory: []
    }, currentTaskId);

    if (propertyId) {
      const task = await Task.findOne({ propertyId: propertyId });
      if (task) geminiService.updateContext({ currentProperty: task }, currentTaskId);
    }

    res.json({ success: true, message: 'Workflow reset successfully' });
  } catch (error) {
    console.error('Reset workflow error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset workflow' });
  }
};

// Update workflow progress
const updateWorkflowProgress = async (req, res) => {
  try {
    const { propertyId, roomType, progress } = req.body;
    if (!propertyId || !roomType || !progress) return res.status(400).json({ success: false, message: 'Property ID, room type, and progress are required' });

    scoringService.updateWorkflowProgress(propertyId, roomType, progress);
    res.json({ success: true, message: 'Workflow progress updated successfully' });
  } catch (error) {
    console.error('Update workflow progress error:', error);
    res.status(500).json({ success: false, message: 'Failed to update workflow progress' });
  }
};

// Update AI context
const updateContext = async (req, res) => {
  try {
    const { currentProperty, currentRoom, completedTasks, photos, manualTips, currentWorkflow, taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'Task ID is required' });
    }

    geminiService.updateContext({
      currentProperty,
      currentRoom,
      completedTasks: completedTasks || [],
      photos: photos || { before: [], after: [], during: [] },
      manualTips: manualTips || [],
      currentWorkflow: currentWorkflow || []
    }, taskId);
    res.json({ success: true, message: 'AI context updated successfully' });
  } catch (error) {
    console.error('Update context error:', error);
    res.status(500).json({ success: false, message: 'Failed to update AI context' });
  }
};

// Reset AI context
const resetAIContext = async (req, res) => {
  try {
    const { taskId } = req.body;

    if (taskId) {
      // Reset specific task context
      geminiService.resetContext(taskId);
      const context = geminiService.getContext(taskId);
      res.json({
        success: true,
        message: 'AI context reset successfully for specific task',
        data: { workflowState: context.workflowState, chatHistoryLength: context.chatHistory.length }
      });
    } else {
      // Reset all contexts
      geminiService.resetContext();
      res.json({
        success: true,
        message: 'All AI contexts reset successfully',
        data: { contextsCleared: true }
      });
    }
  } catch (error) {
    console.error('Reset context error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset AI context' });
  }
};

// Get manual requirements
const getManualRequirements = async (req, res) => {
  try {
    const { propertyId, roomType } = req.params;
    if (!propertyId || !roomType) return res.status(400).json({ success: false, message: 'Property ID and room type are required' });

    // First try to find a task for this property
    const task = await Task.findOne({ propertyId: propertyId });
    if (task) {
      const roomRequirement = task.requirements.find(rt => rt.roomType.toLowerCase() === roomType.toLowerCase());
      if (roomRequirement) {
        const response = {
          roomType: roomRequirement.roomType,
          tasks: roomRequirement.tasks,
          isCompleted: roomRequirement.isCompleted,
          specialRequirement: task.specialRequirement
        };
        return res.json({ success: true, data: response });
      }
    }

    // Fallback to property if no task found
    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    const roomTask = property.roomTasks.find(rt => rt.roomType === roomType);
    if (!roomTask) return res.status(404).json({ success: false, message: 'Room type not found in property manual' });

    res.json({ success: true, data: roomTask });
  } catch (error) {
    console.error('Get manual requirements error:', error);
    res.status(500).json({ success: false, message: 'Failed to get manual requirements' });
  }
};

// Test intelligent text analysis
const testTextAnalysis = async (req, res) => {
  try {
    const { userMessage } = req.body;
    if (!userMessage) return res.status(400).json({ success: false, message: 'User message is required' });

    const analysis = geminiService.analyzeTextForPhotoInfo(userMessage);
    res.json({ success: true, data: { originalMessage: userMessage, analysis } });
  } catch (error) {
    console.error('Text analysis test error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze text' });
  }
};

// Get scoring history for a task
const getScoringHistory = async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ success: false, message: 'Task ID is required' });

    const scoringHistory = scoringService.getScoringHistory(taskId);
    if (!scoringHistory) {
      return res.status(404).json({ success: false, message: 'No scoring history found for this task' });
    }

    res.json({ success: true, data: scoringHistory });
  } catch (error) {
    console.error('Get scoring history error:', error);
    res.status(500).json({ success: false, message: 'Failed to get scoring history' });
  }
};

// Get property scoring summary
const getPropertyScoringSummary = async (req, res) => {
  try {
    const { propertyId } = req.params;
    if (!propertyId) return res.status(400).json({ success: false, message: 'Property ID is required' });

    const summary = scoringService.getPropertyScoringSummary(propertyId);
    if (!summary) {
      return res.status(404).json({ success: false, message: 'No scoring summary found for this property' });
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Get property scoring summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to get property scoring summary' });
  }
};

const generatePublicBookingBrief = async (req, res) => {
  try {
    const payload = req.body || {};
    const fallback = buildFallbackBookingBrief(payload);

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, message: 'Booking payload is required' });
    }

    const addonList = normalizeAddonList(payload.addons);
    const schedule = normalizeSchedule(payload.schedule);
    const prompt = `You are preparing a concise cleaner-facing booking brief for a residential cleaning visit.

Return STRICT JSON with this shape only:
{
  "summary": "string",
  "cleanerChecklist": ["string"],
  "roomFocus": ["string"],
  "opsNotes": ["string"]
}

Rules:
- Keep it operational, concrete, and short.
- Do not mention being an AI.
- Do not invent issues, damage, or promises.
- Use the booking facts only.
- Mention maintenance add-on only if one is selected.
- Keep each bullet under 18 words.

Booking facts:
Service type: ${String(payload.serviceType || 'standard')}
Condition: ${String(payload.condition || 'normal')}
Request flow: ${String(payload.serviceRequestType || 'instant')}
Frequency: ${String(payload.frequency || 'once')}
Beds: ${Number(payload.beds || 0)}
Baths: ${Number(payload.baths || 0)}
Square footage: ${Number(payload.sqft || 0)}
Selected add-ons: ${addonList.length ? addonList.join(', ') : 'none'}
Maintenance label: ${String(payload.maintenanceLabel || 'none')}
Pack id: ${String(payload.packId || 'none')}
Visits scheduled: ${schedule.length}
First slot: ${schedule[0] ? `${schedule[0].date} ${schedule[0].time}` : 'not provided'}
Estimated cleaning minutes: ${Number(payload.aiMinutes || 0)}
City/state: ${[payload.city, payload.state].filter(Boolean).join(', ') || 'not provided'}
Checkout total: ${Number(payload.checkoutTotal || 0)}`;

    if (!geminiService?.model) {
      return res.json({ success: true, data: fallback });
    }

    try {
      const result = await geminiService.model.generateContent(prompt, {
        generationConfig: { temperature: 0.2, top_p: 0.9 },
      });
      const response = await result.response;
      const raw = String(response.text() || '').trim();
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      return res.json({
        success: true,
        data: {
          source: 'gemini',
          summary: String(parsed?.summary || fallback.summary),
          cleanerChecklist: asArray(parsed?.cleanerChecklist).filter(Boolean).slice(0, 6),
          roomFocus: asArray(parsed?.roomFocus).filter(Boolean).slice(0, 6),
          opsNotes: asArray(parsed?.opsNotes).filter(Boolean).slice(0, 6),
        },
      });
    } catch (error) {
      console.error('Public booking brief AI error:', error);
      return res.json({ success: true, data: fallback });
    }
  } catch (error) {
    console.error('Generate public booking brief error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate booking brief' });
  }
};

module.exports = {
  chatWithAI,
  handlePhotoUpload,
  scoreBeforeAfterPhotos,
  analyzeBeforeAfterPhotos,
  analyzePhotoWithManual,
  generateWorkflowGuidance,
  generatePublicBookingBrief,
  getWorkflowState,
  getChatHistory,
  saveChatMessageAPI,
  resetWorkflow,
  updateWorkflowProgress,
  updateContext,
  resetAIContext,
  getManualRequirements,
  testTextAnalysis,
  getScoringHistory,
  getPropertyScoringSummary
};

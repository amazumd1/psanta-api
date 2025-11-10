const { GoogleGenerativeAI } = require('@google/generative-ai');
const Property = require('../models/Property');
const Task = require('../models/Task');
require('dotenv').config({ path: '../config.env' });

class GeminiService {
  constructor() {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    this.genAI = new GoogleGenerativeAI(API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    this.useEnhancedMockData = false;
    // Store contexts by task ID instead of single shared context
    this.contexts = new Map();
  }

  // Get context for a specific task
  getContext(taskId) {
    if (!taskId) {
      console.warn('No taskId provided to getContext - using default context');
      taskId = 'default';
    }
    
    if (!this.contexts.has(taskId)) {
      console.log(`Creating new context for task: ${taskId}`);
      this.contexts.set(taskId, this.createNewContext());
    }
    
    console.log(`Using context for task: ${taskId}, total contexts: ${this.contexts.size}`);
    return this.contexts.get(taskId);
  }

  // Create a new context for a task
  createNewContext() {
    return {
      currentProperty: null,
      currentRoom: null,
      completedTasks: [],
      photos: [], // Array to store all photos with metadata
      photoStorage: { // Object to store photos by type and room for easy access
        before: {},
        after: {}
      },
      manualTips: [],
      currentWorkflow: [],
      workflowState: 'initial', // initial, manual_explained, before_photos_requested, after_photos_requested, completed
      beforePhotosLogged: [], // Track which rooms have before photos
      afterPhotosLogged: [], // Track which rooms have after photos
      chatHistory: [], // Store chat history for memory
      currentRoomIndex: 0, // Track current room being processed
      scoringHistory: {} // Track actual scoring data for each room
    };
  }

  resetContext(taskId = null) {
    if (taskId) {
      // Reset specific task context
      this.contexts.set(taskId, this.createNewContext());
    } else {
      // Reset all contexts
      this.contexts.clear();
    }
  }

  // Update context with new information for a specific task
  updateContext(updates, taskId = null) {
    if (!taskId) {
      console.warn('No taskId provided to updateContext - using default context');
      // For backward compatibility, use a default context
      const defaultContext = this.getContext('default');
      Object.assign(defaultContext, updates);
      return;
    }
    
    console.log(`Updating context for task: ${taskId} with updates:`, Object.keys(updates));
    const context = this.getContext(taskId);
    Object.assign(context, updates);
  }

  // Add message to chat history for a specific task
  addToChatHistory(message, sender, taskId) {
    const context = this.getContext(taskId);
    context.chatHistory.push({
      message,
      sender,
      timestamp: new Date()
    });
    
    // Keep only last 50 messages to manage memory
    if (context.chatHistory.length > 50) {
      context.chatHistory = context.chatHistory.slice(-50);
    }
  }

  // Restore context from task's chat history
  async restoreContextFromHistory(taskId) {
    try {
      const task = await Task.findById(taskId);
      if (!task || !task.chatHistory || task.chatHistory.length === 0) {
        console.log(`No chat history found for task: ${taskId}`);
        return false;
      }

      const context = this.getContext(taskId);
      
      // Restore chat history to AI context
      context.chatHistory = task.chatHistory.map(chat => ({
        message: chat.message,
        sender: chat.sender,
        timestamp: new Date(chat.timestamp)
      }));

      // Analyze chat history to restore workflow state
      const hasBeforePhotos = task.chatHistory.some(chat => 
        chat.type === 'photo' && chat.message.includes('before')
      );
      const hasAfterPhotos = task.chatHistory.some(chat => 
        chat.type === 'photo' && chat.message.includes('after')
      );

      if (hasBeforePhotos) {
        context.beforePhotosLogged = ['restored_from_history'];
        context.workflowState = 'before_photos_requested';
      }
      if (hasAfterPhotos) {
        context.afterPhotosLogged = ['restored_from_history'];
        context.workflowState = 'after_photos_requested';
      }

      // Restore current property if available
      if (task) {
        context.currentProperty = task;
      }

      console.log(`Restored context from history for task: ${taskId}, ${context.chatHistory.length} messages`);
      return true;
    } catch (error) {
      console.error('Error restoring context from history:', error);
      return false;
    }
  }

  // Generate chat response with workflow management for a specific task
  async generateChatResponse(userMessage, taskId = null) {
    try {
      if (!taskId) {
        console.warn('No taskId provided to generateChatResponse - using default context');
        taskId = 'default';
      }
      
      const context = this.getContext(taskId);
      
      // Add user message to history
      this.addToChatHistory(userMessage, 'user', taskId);
      
      // Check if workflow is completed and automatically provide summary
      if (context.workflowState === 'completed' && Object.keys(context.scoringHistory).length > 0) {
        const completionSummary = this.generateFinalSummary(context);
        
        this.addToChatHistory(completionSummary, 'assistant', taskId);
        return completionSummary;
      }
      
      const prompt = this.buildWorkflowPrompt(userMessage, context);
      const result = await this.model.generateContent(prompt, { generationConfig: { temperature: 0, top_p: 1 } });
      const response = await result.response;
      const aiResponse = response.text();
      
      // Add AI response to history
      this.addToChatHistory(aiResponse, 'assistant', taskId);
      
      return aiResponse;
    } catch (error) {
      console.error('Gemini API error:', error);
      // Use enhanced fallback response with better context awareness
      return this.getEnhancedFallbackResponse(userMessage, taskId);
    }
  }

  // Build workflow prompt with memory and state management for a specific context
  buildWorkflowPrompt(userMessage, context) {
    const { currentProperty, workflowState, beforePhotosLogged, afterPhotosLogged, chatHistory, currentRoomIndex, scoringHistory } = context;
    
    let prompt = `You are PropertySanta AI, a professional cleaning assistant. You are guiding a cleaner through a systematic cleaning process with photo documentation and scoring.

    Current Workflow State: ${workflowState}
    Before Photos Logged: ${beforePhotosLogged.join(', ')}
    After Photos Logged: ${afterPhotosLogged.join(', ')}

    ACTUAL SCORING DATA (use these numbers for calculations):
    ${Object.keys(scoringHistory).length > 0 ? 
      Object.entries(scoringHistory).map(([room, score]) => 
        `${room}: ${score.overallScore}/100 (Manual Compliance: ${score.manualComplianceScore}%)`
      ).join('\n') : 
      'No scoring data available yet'
    }

    Chat History (Last 10 messages):
    ${chatHistory.slice(-10).map(msg => `${msg.sender}: ${msg.message}`).join('\n')}

    User Message: ${userMessage}

    Property Details:
    ${currentProperty ? currentProperty.name : 'No property loaded'}
    
    Special Requirements:
    ${currentProperty?.specialRequirement ? currentProperty.specialRequirement : 'No special requirements'}
    
    Room Tasks:
    ${currentProperty?.requirements?.map(rt => 
      `${rt.roomType}:\n` +
      rt.tasks.map((task, i) => 
        `  ${i+1}. ${task.description}${task.isCompleted ? ' ✓' : ''}`
      ).join('\n') +
      (rt.specialInstructions?.length ? 
        '\n  Special Instructions:\n  - ' + rt.specialInstructions.join('\n  - ') : ''
      )
    ).join('\n\n') || 'No rooms defined'}

    Follow this exact workflow:

    1. INITIAL STATE: If workflowState is 'initial', explain the manual briefly and ask for before photo of first room.

    2. MANUAL_EXPLAINED: If workflowState is 'manual_explained', ask for before photo of current room and emphasize key tasks from manual.

    3. BEFORE_PHOTOS_REQUESTED: If before photo is uploaded, log it and move to next room. If all before photos are logged, ask for after photo of first room.

    4. AFTER_PHOTOS_REQUESTED: If after photo is uploaded, score the before/after comparison and move to next room.

    5. COMPLETED: If all rooms are scored, automatically provide final summary with total score and payment information.

    IMPORTANT RULES:
    - Be friendly, conversational, and encouraging - like talking to a helpful colleague
    - Use natural language and emojis to make responses more engaging
    - Adapt your tone to match the user's mood and message type
    - For casual conversation (goodbyes, thanks, greetings), respond naturally and warmly
    - For technical tasks, be professional but still friendly
    - Emphasize key manual requirements for each room
    - ALWAYS consider and mention special requirements when relevant to the current task
    - If special requirements exist, incorporate them into your guidance and responses
    - Remember what photos have been logged
    - Guide user step by step through the process
    - If user uploads duplicate photo, remind them politely
    - Always mention the specific room you're working on
    - Provide clear next steps after each action
    - NEVER mention technical workflow states like 'INITIAL', 'BEFORE_PHOTOS_REQUESTED', etc.
    - Use natural, conversational language
    - If user just says "BEFORE" or "AFTER", guide them to upload the photo
    - CRITICAL: When calculating scores or providing score summaries, ONLY use the actual scoring data provided. Do NOT make up or invent scores like "10/10" or "20/20". If you don't have specific scoring data, say "I don't have the specific scoring data available" rather than inventing numbers.
    - If user asks for sum of scores, calculate based on actual scoring data only, not made-up numbers.
    - When all tasks are completed, automatically provide the total score and payment information without being asked.
    - Always mention that the cleaner will be paid by the property owner when work is completed.
    - Vary your responses - don't use the same phrases repeatedly
    - Show personality and be helpful in a natural way

    Respond naturally and follow the workflow state exactly.`;

    return prompt;
  }

  // Handle photo upload with memory and workflow state for a specific task
  async handlePhotoUpload(photoBase64, photoType, roomType, userMessage, taskId = null) {
    try {
      if (!taskId) {
        console.warn('No taskId provided to handlePhotoUpload - using default context');
        taskId = 'default';
      }
      
      const context = this.getContext(taskId);
      const { workflowState, beforePhotosLogged, afterPhotosLogged, currentProperty } = context;
      // Use intelligent text analysis to extract room type and photo type
      const textAnalysis = this.analyzeTextForPhotoInfo(userMessage);      
      // Use detected values if they have high confidence, otherwise fall back to provided parameters
      const detectedRoomType = textAnalysis.roomConfidence > 0.7 ? textAnalysis.roomType : roomType;
      const detectedPhotoType = textAnalysis.photoConfidence > 0.7 ? textAnalysis.photoType : photoType;
      
      console.log(`🎯 Using detected: ${detectedRoomType} ${detectedPhotoType} (confidence: ${textAnalysis.confidence})`);
      
      // If we couldn't detect room type from text, try to improve detection
      if (detectedRoomType === 'unknown' && userMessage) {
        const roomKeywords = ['bedroom', 'bathroom', 'kitchen', 'living', 'dining', 'office', 'laundry'];
        for (const room of roomKeywords) {
          if (userMessage.toLowerCase().includes(room)) {
            roomType = room;
            break;
          }
        }
      }
      
      // Check if this photo was already uploaded
      const existingPhotos = [...beforePhotosLogged, ...afterPhotosLogged];
      if (existingPhotos.includes(`${detectedRoomType}-${detectedPhotoType}`)) {
        const roomName = detectedRoomType ? detectedRoomType.toUpperCase() : 'this room';
        const photoTypeName = detectedPhotoType ? detectedPhotoType.toUpperCase() : 'photo';
        return {
          message: `I notice you've already uploaded a ${photoTypeName} photo for ${roomName}. Let me check if we need to proceed with the next step or if you'd like to upload a different photo.`,
          shouldAnalyze: false
        };
      }

      // If we still don't have clear information, ask for clarification
      if (detectedRoomType === 'unknown' || detectedPhotoType === 'unknown') {
        return {
          message: textAnalysis.message,
          shouldAnalyze: false
        };
      }

      // Analyze photo based on workflow state
      if (detectedPhotoType === 'before') {
        // Log before photo
        context.beforePhotosLogged.push(`${detectedRoomType}-before`);
        
        // Store the before photo in photoStorage
        context.photoStorage.before[detectedRoomType] = photoBase64;
        
        // Create photo object
        const photoData = {
          url: `data:image/jpeg;base64,${photoBase64}`,
          type: 'before',
          roomType: detectedRoomType,
          uploadedAt: new Date(),
          isUploaded: true,
          tags: [`${detectedRoomType}`, 'before']
        };
        
        // Store in context
        context.photos.push(photoData);
        
        if (context.currentProperty?._id) {
          try {
            await Task.findByIdAndUpdate(
              context.currentProperty._id,
              {
                $push: {
                  photos: photoData
                }
              },
              { new: true, runValidators: true }
            );
            console.log(`Saved ${detectedRoomType} before photo to MongoDB for task ${taskId}`);
          } catch (error) {
            console.error('Failed to save before photo to MongoDB:', error);
          }
        }
        
        // Get room requirements for emphasis
        const manualRequirements = this.getManualRequirementsForRoom(detectedRoomType, context);
        
        // Get all unique room types that need before photos
        const allRooms = [...new Set(currentProperty?.requirements?.map(rt => rt.roomType) || [])];
        
        // Check if all rooms have before photos
        const roomsWithBeforePhotos = new Set(
          context.beforePhotosLogged.map(photo => photo.split('-')[0])
        );
        
        const allBeforePhotosLogged = allRooms.every(room => 
          roomsWithBeforePhotos.has(room.toLowerCase())
        );
        
        // Prepare response for current room
        const roomName = detectedRoomType ? detectedRoomType.toUpperCase() : 'ROOM';
        let responseMessage = `${textAnalysis.message}\n\n✅ ${roomName} BEFORE photo logged successfully!\n\n📋 Key tasks to focus on:\n${this.formatManualRequirements(manualRequirements)}`;
        
        if (allBeforePhotosLogged) {
          // All before photos are done, switch to after photos
          context.workflowState = 'after_photos_requested';
          context.currentRoomIndex = 0;
          
          const nextRoom = allRooms[0];
          const nextRoomName = nextRoom ? nextRoom.toUpperCase() : 'ROOM';
          
          responseMessage += `\n\n🎯 All before photos are now logged! Let's start with after photos. Please upload "${nextRoomName} AFTER" photo.`;
        } else {
          // More before photos needed
          const nextRoom = allRooms.find(room => 
            !roomsWithBeforePhotos.has(room.toLowerCase())
          );
          const nextRoomName = nextRoom ? nextRoom.toUpperCase() : 'ROOM';
          
          responseMessage += `\n\n📸 Next: Please upload "${nextRoomName} BEFORE" photo.`;
        }
        
        return {
          message: responseMessage,
          shouldAnalyze: false
        };
      } else if (detectedPhotoType === 'after') {
        // Check if we have the corresponding before photo
        const roomName = detectedRoomType || 'the room';
        const roomNameUpper = roomName.toUpperCase();
        
        if (!context.beforePhotosLogged.includes(`${detectedRoomType}-before`)) {
          return {
            message: `${textAnalysis.message}\n\n❌ I don't see a BEFORE photo for ${roomName}. Please upload "${roomNameUpper} BEFORE" photo first, then the AFTER photo.`,
            shouldAnalyze: false
          };
        }
        
        // Get the before photo for comparison from photoStorage
        const beforePhotoBase64 = context.photoStorage.before[detectedRoomType];
        
        if (!beforePhotoBase64) {
          return {
            message: `❌ Could not find the BEFORE photo for ${roomNameUpper}. Please upload the BEFORE photo first.`,
            shouldAnalyze: false
          };
        }
        
        // Get manual requirements for scoring
        const manualRequirements = this.getManualRequirementsForRoom(detectedRoomType, context);
        
        try {
          // Compare before and after photos
          const scoring = await this.analyzeBeforeAfterComparison(
            beforePhotoBase64,
            photoBase64,
            detectedRoomType,
            manualRequirements
          );
          
          // Store the scoring results
          context.scoring = context.scoring || {};
          context.scoring[detectedRoomType] = scoring;
          
          // Save analysis results to MongoDB if we have a property ID
          if (context.currentProperty?._id) {
            try {
              const taskId = context.currentProperty._id;
              
              // Create issues from scoring results
              const issues = [];
              
              // Add missed requirements as issues
              if (scoring.missedRequirements?.length > 0) {
                issues.push(...scoring.missedRequirements.map(desc => ({
                  type: 'missed_requirement',
                  description: desc,
                  location: detectedRoomType,
                  isResolved: false
                })));
              }
              
              // Add rework areas as issues
              if (scoring.reWorkAreas?.length > 0) {
                issues.push(...scoring.reWorkAreas.map(desc => ({
                  type: 'needs_attention',
                  description: desc,
                  location: detectedRoomType,
                  isResolved: false
                })));
              }
              
              // Calculate score percentage
              const scorePercentage = Math.round(scoring.overallScore);
              
              // Create AI feedback with score percentage
              const aiFeedback = [{
                feedback: `${detectedRoomType} cleaning analysis - Score: ${scorePercentage}%`,
                score: scorePercentage,
                confidence: scoring.confidence || 0.8,
                suggestions: scoring.recommendations || [],
                improvements: scoring.improvements || [],
                timestamp: new Date(),
                roomType: detectedRoomType,
                analysisType: 'after_cleaning'
              }];
              
              await Task.findByIdAndUpdate(
                taskId,
                {
                  $push: {
                    issues: { $each: issues },
                    aiFeedback: { $each: aiFeedback }
                  }
                },
                { new: true, runValidators: true }
              );
              
              console.log(`Saved analysis results for ${detectedRoomType} to task ${taskId}`);
            } catch (error) {
              console.error('Failed to save analysis results to MongoDB:', error);
              // Continue even if save fails - we don't want to break the user flow
            }
          }
          
          // Log after photo
          context.afterPhotosLogged.push(`${detectedRoomType}-after`);
          
          // Store the after photo with scoring reference
          // Store the after photo in photoStorage
          context.photoStorage.after[detectedRoomType] = photoBase64;
          
          // Create photo object with scoring
          const photoData = {
            url: `data:image/jpeg;base64,${photoBase64}`,
            type: 'after',
            roomType: detectedRoomType,
            uploadedAt: new Date(),
            isUploaded: true,
            tags: [`${detectedRoomType}`, 'after'],
            scoring: {
              score: scoring.overallScore,
              meetsStandards: scoring.meetsManualStandards,
              timestamp: new Date()
            }
          };
          
          // Store in context
          context.photos.push(photoData);
          
          // Save to MongoDB and update room task completion if we have a property ID
          if (context.currentProperty?._id) {
            try {
              // Update the property to add the photo and mark the room task as completed
              await Task.findOneAndUpdate(
                {
                  _id: context.currentProperty._id,
                  'requirements.roomType': detectedRoomType
                },
                {
                  $push: {
                    photos: photoData
                  },
                  $set: {
                    'requirements.$.isCompleted': true,
                    'requirements.$.completedAt': new Date()
                  }
                },
                { new: true, runValidators: true }
              );
              
              console.log(`Saved ${detectedRoomType} after photo and marked task as completed in MongoDB for task ${taskId}`);
            } catch (error) {
              console.error('Failed to save after photo or update task completion in MongoDB:', error);
            }
          }
          
          // Get all unique room types that need after photos
          const allRooms = [...new Set(currentProperty?.requirements?.map(rt => rt.roomType) || [])];
          
          // Check if all rooms have after photos
          const roomsWithAfterPhotos = new Set(
            context.afterPhotosLogged.map(photo => photo.split('-')[0])
          );
          
          const allAfterPhotosLogged = allRooms.every(room => 
            roomsWithAfterPhotos.has(room.toLowerCase())
          );
          
          // Format the scoring results for display
          const scorePercentage = Math.round(scoring.overallScore);
          const scoreEmoji = scorePercentage >= 80 ? '🌟' : scorePercentage >= 60 ? '👍' : '⚠️';
          
          let responseMessage = `${textAnalysis.message}\n\n✅ ${roomNameUpper} AFTER photo analyzed! ${scoreEmoji}\n`;
          responseMessage += `\n📊 Cleaning Score: ${scorePercentage}%`;
          
          if (scoring.improvements?.length > 0) {
            responseMessage += '\n\n✅ Improvements:';
            scoring.improvements.forEach(imp => {
              responseMessage += `\n• ${imp}`;
            });
          }
          
          if (scoring.missedRequirements?.length > 0) {
            responseMessage += '\n\n❌ Missed Requirements:';
            scoring.missedRequirements.forEach(req => {
              responseMessage += `\n• ${req}`;
            });
          }
          
          if (scoring.reWorkAreas?.length > 0) {
            responseMessage += '\n\n⚠️ Needs Attention:';
            scoring.reWorkAreas.forEach(area => {
              responseMessage += `\n• ${area}`;
            });
          }
          
          if (scoring.recommendations?.length > 0) {
            responseMessage += '\n\n💡 Recommendations:';
            scoring.recommendations.forEach(rec => {
              responseMessage += `\n• ${rec}`;
            });
          }
          
            // Add final status
          responseMessage += `\n\n${scoring.meetsManualStandards ? '✅' : '❌'} `;
          responseMessage += scoring.meetsManualStandards 
            ? 'This room meets all cleaning standards!' 
            : 'This room does not meet all cleaning standards. Please check the issues above.';
          
          if (allAfterPhotosLogged) {
            // All photos are done
            context.workflowState = 'completed';
            context.completedAt = new Date();
            responseMessage += '\n\n🎉 Great job! You have completed all photo documentation for this property.';
            responseMessage += '\n\nThe property owner will review your work and process your payment.';
        } else {
          // More after photos needed
          const nextRoom = allRooms.find(room => 
            !roomsWithAfterPhotos.has(room.toLowerCase()) && 
            context.beforePhotosLogged.includes(`${room}-before`)
          );
          
          if (nextRoom) {
            const nextRoomName = nextRoom.toUpperCase();
            responseMessage += `\n\n📸 Next: Please upload "${nextRoomName} AFTER" photo.`;
          } else {
            // This could happen if there are no more rooms with before photos
            responseMessage += '\n\n✅ All rooms with before photos now have after photos. ';
            responseMessage += 'If you have more rooms to document, please upload their BEFORE photos first.';
          }
        }
        
          return {
            message: responseMessage,
            shouldAnalyze: true
          };
        } catch (error) {
          console.error('Error analyzing after photo:', error);
          return {
            message: '❌ Error analyzing the after photo. Please try again.',
            shouldAnalyze: false
          };
        }
      } else if (detectedPhotoType === 'during') {
        // Handle during photos (progress photos)
        const manualRequirements = this.getManualRequirementsForRoom(detectedRoomType, context);
        const analysis = await this.analyzePhotoWithManual(photoBase64, detectedPhotoType, detectedRoomType, manualRequirements);
        
        return {
          message: `${textAnalysis.message}\n\n📸 ${detectedRoomType.toUpperCase()} progress photo logged!\n\n📊 Current Progress:\n• Manual Compliance: ${analysis.manualCompliance}%\n• Cleanliness Score: ${analysis.cleanlinessScore}%\n• Acceptable Progress: ${analysis.acceptableProgress ? 'Yes' : 'No'}\n\n💡 Keep up the good work! Continue with the cleaning tasks.`,
          shouldAnalyze: false,
          analysis
        };
      }
      
      return {
        message: textAnalysis.message,
        shouldAnalyze: false
      };
    } catch (error) {
      console.error('Photo upload handling error:', error);
      return {
        message: '❌ Error processing photo. Please try again.',
        shouldAnalyze: false
      };
    }
  }

  // Intelligent text analysis to extract room type and photo type from user message
  analyzeTextForPhotoInfo(userMessage) {
    if (!userMessage) {
      return {
        roomType: 'unknown',
        photoType: 'unknown',
        confidence: 0,
        message: 'No text provided with photo'
      };
    }

    const lowerMessage = userMessage.toLowerCase().trim();
    console.log(`🔍 Analyzing text: "${userMessage}"`);

    // Room type detection with expanded keywords
    const roomPatterns = [
      { type: 'bedroom', keywords: ['bedroom', 'bed room', 'master bedroom', 'guest bedroom', 'bed'] },
      { type: 'bathroom', keywords: ['bathroom', 'bath room', 'toilet', 'shower', 'bath'] },
      { type: 'kitchen', keywords: ['kitchen', 'cooking area', 'stove', 'sink', 'counter'] },
      { type: 'living room', keywords: ['living room', 'livingroom', 'lounge', 'sitting room', 'tv room'] },
      { type: 'dining room', keywords: ['dining room', 'diningroom', 'dining area', 'table'] },
      { type: 'office', keywords: ['office', 'study', 'work room', 'desk'] },
      { type: 'laundry room', keywords: ['laundry room', 'laundry', 'washer', 'dryer'] },
      { type: 'garage', keywords: ['garage', 'car port', 'parking'] },
      { type: 'basement', keywords: ['basement', 'cellar', 'lower level'] },
      { type: 'attic', keywords: ['attic', 'loft', 'upper level'] }
    ];

    // Photo type detection
    const photoTypePatterns = [
      { type: 'before', keywords: ['before', 'pre', 'initial', 'dirty', 'messy', 'start'] },
      { type: 'after', keywords: ['after', 'post', 'final', 'clean', 'finished', 'done', 'complete'] },
      { type: 'during', keywords: ['during', 'progress', 'in progress', 'working', 'mid'] }
    ];

    let detectedRoomType = 'unknown';
    let detectedPhotoType = 'unknown';
    let roomConfidence = 0;
    let photoConfidence = 0;

    // Detect room type
    for (const pattern of roomPatterns) {
      for (const keyword of pattern.keywords) {
        if (lowerMessage.includes(keyword)) {
          detectedRoomType = pattern.type;
          roomConfidence = 0.9;
          console.log(`✅ Detected room type: ${pattern.type} (confidence: ${roomConfidence})`);
          break;
        }
      }
      if (detectedRoomType !== 'unknown') break;
    }

    // Detect photo type
    for (const pattern of photoTypePatterns) {
      for (const keyword of pattern.keywords) {
        if (lowerMessage.includes(keyword)) {
          detectedPhotoType = pattern.type;
          photoConfidence = 0.9;
          console.log(`✅ Detected photo type: ${pattern.type} (confidence: ${photoConfidence})`);
          break;
        }
      }
      if (detectedPhotoType !== 'unknown') break;
    }

    // Additional context clues
    if (detectedPhotoType === 'unknown') {
      // Look for context clues
      if (lowerMessage.includes('clean') || lowerMessage.includes('finished') || lowerMessage.includes('done')) {
        detectedPhotoType = 'after';
        photoConfidence = 0.7;
      } else if (lowerMessage.includes('start') || lowerMessage.includes('begin') || lowerMessage.includes('mess')) {
        detectedPhotoType = 'before';
        photoConfidence = 0.7;
      }
    }

    // Generate intelligent response message
    let message = '';
    if (detectedRoomType !== 'unknown' && detectedPhotoType !== 'unknown') {
      message = `Perfect! I can see this is a ${detectedRoomType} ${detectedPhotoType} photo. `;
      
      if (detectedPhotoType === 'before') {
        message += `I can see the initial state of the ${detectedRoomType}. Let's get started with the cleaning tasks!`;
      } else if (detectedPhotoType === 'after') {
        message += `Great work! I can see the ${detectedRoomType} has been cleaned. Let me assess the quality.`;
      } else {
        message += `I can see the progress in the ${detectedRoomType}. Keep up the good work!`;
      }
    } else if (detectedRoomType !== 'unknown') {
      message = `I can see this is a ${detectedRoomType}. Is this a before or after photo?`;
    } else if (detectedPhotoType !== 'unknown') {
      message = `I can see this is a ${detectedPhotoType} photo. Which room is this?`;
    } else {
      message = `I can see you've uploaded a photo. Could you tell me which room this is and whether it's a before or after photo?`;
    }

    const overallConfidence = (roomConfidence + photoConfidence) / 2;

    return {
      roomType: detectedRoomType,
      photoType: detectedPhotoType,
      confidence: overallConfidence,
      message: message,
      roomConfidence: roomConfidence,
      photoConfidence: photoConfidence
    };
  }

  // Get manual requirements for a specific room
  getManualRequirementsForRoom(roomType, context) {
    if (!context.currentProperty || !context.currentProperty.requirements) {
      return ['No room tasks available.'];
    }

    // Find the room task that matches the room type (case insensitive)
    const requirements = context.currentProperty.requirements.find(
      rt => rt.roomType.toLowerCase() === roomType.toLowerCase()
    );

    if (!requirements) {
      return [`No tasks found for ${roomType}.`];
    }

    const requirementsList = [
      ...requirements.tasks.map(task => 
        `- ${task.description}${task.isCompleted ? ' (Completed)' : ''}`
      )
    ];

    // Add special requirements if they exist
    if (context.currentProperty.specialRequirement) {
      requirementsList.push('', '⚠️ Special Requirements:');
      requirementsList.push(`- ${context.currentProperty.specialRequirement}`);
    }

    if (context.currentProperty.specialInstructions && context.currentProperty.specialInstructions.length > 0) {
      requirementsList.push('', 'Special Instructions:');
      requirementsList.push(...context.currentProperty.specialInstructions);
    }

    return requirementsList;
  }

  // Format manual requirements for display
  formatManualRequirements(requirements) {
    return requirements || 'Follow the manual requirements for this room.';
  }

  // Format scoring results for display
  formatScoringResults(scoring) {
    return `📊 Overall Score: ${scoring.overallScore}/100 (${scoring.detailedScoring?.grade || 'N/A'})
            📋 Manual Compliance: ${scoring.manualComplianceScore}/100
            ✅ Meets Standards: ${scoring.meetsManualStandards ? 'Yes' : 'No'}

            🎉 Improvements Made:
            ${scoring.improvements.map(imp => `• ${imp}`).join('\n')}

            ${scoring.missedRequirements.length > 0 ? `⚠️ Areas for Improvement:\n${scoring.missedRequirements.map(req => `• ${req}`).join('\n')}` : ''}`;
  }

  // Generate final summary
  generateFinalSummary(context) {
    const { currentProperty, afterPhotosLogged, scoringHistory } = context;
    const allRooms = currentProperty?.requirements?.map(rt => rt.roomType) || [];
    
    let summary = `🏠 Property: ${currentProperty?.name || 'Unknown'}\n`;
    summary += `📸 Rooms Completed: ${allRooms.length}\n`;
    
    // Add actual scoring data if available
    if (Object.keys(scoringHistory).length > 0) {
      summary += `\n📊 Final Scoring Summary:\n`;
      let totalScore = 0;
      let totalCompliance = 0;
      let roomCount = 0;
      
      Object.entries(scoringHistory).forEach(([room, score]) => {
        summary += `• ${room.toUpperCase()}: ${score.overallScore}/100 (Compliance: ${score.manualComplianceScore}%)\n`;
        totalScore += score.overallScore;
        totalCompliance += score.manualComplianceScore;
        roomCount++;
      });
      
      if (roomCount > 0) {
        const averageScore = Math.round(totalScore / roomCount);
        const averageCompliance = Math.round(totalCompliance / roomCount);
        summary += `\n🏆 Overall Average: ${averageScore}/100 (Compliance: ${averageCompliance}%)\n`;
        summary += `📈 Total Score: ${totalScore}/${roomCount * 100}\n`;
      }
    }
    
    summary += `\n✅ All before and after photos logged and scored!\n\n`;
    summary += `💰 Payment Information:\nYou will be paid by the property owner for this completed cleaning job. Payment will be processed based on the quality scores achieved.\n\n`;
    summary += `Thank you for using PropertySanta AI! Your cleaning work has been documented and scored based on the manual requirements. See you again! 👋`;
    
    return summary;
  }

  // Get before photo for a room (placeholder - would need to be implemented with actual photo storage)
  getBeforePhotoForRoom(roomType) {
    // This would need to be implemented with actual photo storage
    // For now, return a placeholder
    return 'placeholder_before_photo';
  }

  // Analyze before/after photo comparison for scoring
  async analyzeBeforeAfterComparison(beforePhotoBase64, afterPhotoBase64, roomType, manualRequirements, taskId = null) {
    try {
      console.log(`Starting before/after analysis for ${roomType}`);
      
      // Store the before photo for this room in photoStorage if we have a taskId
      if (taskId) {
        const context = this.getContext(taskId);
        context.photoStorage.before[roomType] = beforePhotoBase64;
      }
      
      // Validate and prepare images
      const beforeImage = this.prepareImageForAnalysis(beforePhotoBase64);
      const afterImage = this.prepareImageForAnalysis(afterPhotoBase64);
      
      console.log('🔍 Image validation results:');
      console.log('Before image valid:', !!beforeImage);
      console.log('After image valid:', !!afterImage);
      
      if (!beforeImage || !afterImage) {
        console.warn('⚠️ Image validation failed.');
        return {
          error: true,
          message: "I'm sorry, but I couldn't process the images properly. The images might be corrupted, in an unsupported format, or too large. Please try uploading the photos again in JPEG or PNG format. Thank you for your patience! 📷",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Try uploading photos in JPEG or PNG format"],
          meetsManualStandards: false
        };
      }
      
      const prompt = `Analyze these before and after photos of a ${roomType} for cleaning quality assessment.

                      Manual Requirements for ${roomType}:
                      ${manualRequirements}

                      Please compare the before and after photos and provide:

                      1. Overall cleanliness improvement score (0-100)
                      2. Manual compliance score (0-100) - how well manual requirements were followed
                      3. Specific improvements made (list each improvement)
                      4. Manual requirements missed (list any requirements not met)
                      5. Areas needing re-work (if any)
                      6. Quality score breakdown:
                        - Surface cleaning: 0-100
                        - Detail work: 0-100
                        - Manual compliance: 0-100
                      7. Recommendations for improvement
                      8. Whether the work meets manual standards (true/false)

                      Respond in JSON format:
                      {
                        "overallScore": 85,
                        "manualComplianceScore": 90,
                        "improvements": ["dust removed", "surfaces cleaned"],
                        "missedRequirements": ["baseboards not cleaned"],
                        "reWorkAreas": ["baseboards"],
                        "qualityBreakdown": {
                          "surfaceCleaning": 90,
                          "detailWork": 75,
                          "manualCompliance": 90
                        },
                        "recommendations": ["clean baseboards", "check corners"],
                        "meetsManualStandards": true
                      }`;
      
      // Create content parts with images and text
      const content = [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: beforeImage } },
        { inlineData: { mimeType: "image/jpeg", data: afterImage } }
      ];
      
      console.log('Sending content to Gemini API for analysis...');
      
      try {
        // Use the standard model with image data
        const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        // Format the content parts as in the working example
        const contentParts = [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: beforeImage
            }
          },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: afterImage
            }
          },
          { text: prompt }
        ];
        
        // Generate content with the model
        const result = await model.generateContent(contentParts);
        
        const response = await result.response;
        const responseText = response.text();
        console.log(`Received response from Gemini API: ${responseText.substring(0, 200)}...`);
        
        return this.parseBeforeAfterAnalysisResponse(responseText);
      } catch (error) {
        console.error('Error calling Gemini API:', error);
        
        // Provide a mock response for testing when API fails
        if (process.env.NODE_ENV !== 'production') {
          console.log('Using mock response due to API error');
          return {
            overallScore: 85,
            manualComplianceScore: 90,
            improvements: [
              'Dust has been removed from surfaces',
              'Floors have been vacuumed and mopped',
              'Surfaces have been wiped down'
            ],
            missedRequirements: [
              'Baseboards still show some dust',
              'Corner behind the door needs attention'
            ],
            reWorkAreas: [
              'Baseboards',
              'Corner behind the door'
            ],
            qualityBreakdown: {
              surfaceCleaning: 90,
              detailWork: 80,
              manualCompliance: 90
            },
            recommendations: [
              'Pay more attention to baseboards',
              'Check corners and edges more thoroughly',
              'Use a microfiber cloth for better dust removal'
            ],
            meetsManualStandards: true
          };
        }
        
        throw error; // Re-throw to be caught by the outer try-catch
      }
    } catch (error) {
      console.error('Before/After analysis error:', error);
      
      // Check for specific API errors
      if (error.status === 429) {
        return {
          error: true,
          message: `I apologize, but I've reached the daily limit for AI photo analysis (quota exceeded). The system can only process 100 photo analyses per day on the free plan. Please try again tomorrow, or you can continue with the next step. Thank you for your patience! 🙏`,
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Please try again tomorrow when the quota resets"],
          meetsManualStandards: false
        };
      }
      
      // Check for authentication errors
      if (error.status === 401) {
        return {
          error: true,
          message: "I'm sorry, but there's an authentication issue with the AI service. The API key may be invalid or expired. Please contact support to resolve this issue. Thank you for your patience! 🔑",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Contact support to fix the API authentication"],
          meetsManualStandards: false
        };
      }
      
      // Check for rate limiting (different from quota)
      if (error.status === 429 && error.errorDetails?.retryDelay) {
        const retryDelay = error.errorDetails.retryDelay;
        return {
          error: true,
          message: `I apologize, but I'm being rate limited by the AI service. Please wait ${retryDelay} before trying again. This is a temporary restriction to prevent overload. Thank you for your patience! ⏰`,
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: [`Wait ${retryDelay} before trying again`],
          meetsManualStandards: false
        };
      }
      
      // Check for server errors
      if (error.status >= 500) {
        return {
          error: true,
          message: "I'm sorry, but the AI service is experiencing server issues right now. This is a temporary problem on their end. Please try again in a few minutes, or you can continue with the next step. Thank you for your patience! 🖥️",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Please try again in a few minutes"],
          meetsManualStandards: false
        };
      }
      
      // Check for other client errors
      if (error.status >= 400 && error.status < 500) {
        return {
          error: true,
          message: `I'm sorry, but there's a client error (${error.status}) with the AI service. This might be due to invalid request format or unsupported image type. Please try with a different photo or contact support. Thank you for your patience! 📷`,
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Try with a different photo or contact support"],
          meetsManualStandards: false
        };
      }
      
      // For network or connection errors
      if (error.message && error.message.includes('fetch')) {
        return {
          error: true,
          message: "I'm sorry, but I can't connect to the AI service right now. This might be due to network issues or the service being temporarily unavailable. Please check your internet connection and try again. Thank you for your patience! 🌐",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Check internet connection and try again"],
          meetsManualStandards: false
        };
      }
      
      // For other unexpected errors
      return {
        error: true,
        message: `I apologize, but I encountered an unexpected error while analyzing your photos: ${error.message || 'Unknown error'}. Please try uploading the photos again, or if the issue persists, contact support. Thank you for your patience! ❓`,
        overallScore: 0,
        manualComplianceScore: 0,
        improvements: [],
        missedRequirements: [],
        reWorkAreas: [],
        qualityBreakdown: {
          surfaceCleaning: 0,
          detailWork: 0,
          manualCompliance: 0
        },
        recommendations: ["Try uploading photos again or contact support"],
        meetsManualStandards: false
      };
    }
  }

  // Analyze single photo with manual-based assessment
  async analyzePhotoWithManual(photoBase64, photoType, roomType, manualRequirements) {
    try {
      console.log(`Starting single photo analysis for ${roomType} (${photoType})`);
      
      // Validate and prepare image
      const preparedImage = this.prepareImageForAnalysis(photoBase64);
      
      if (!preparedImage) {
        console.warn('⚠️ Image validation failed.');
        return {
          error: true,
          message: "I'm sorry, but I couldn't process the image properly. The image might be corrupted, in an unsupported format, or too large. Please try uploading the photo again in JPEG or PNG format. Thank you for your patience! 📷",
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Try uploading photo in JPEG or PNG format"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      const prompt = `Analyze this ${photoType} photo of a ${roomType} against manual requirements.

                      Manual Requirements for ${roomType}:
                      ${manualRequirements}

                      Photo Type: ${photoType}

                      Please provide:
                      1. Manual compliance percentage (0-100)
                      2. Requirements met (list specific requirements completed)
                      3. Requirements missed (list specific requirements not met)
                      4. Current cleanliness score (0-100)
                      5. Next steps based on manual (specific actions needed)
                      6. Confidence level (0-1)
                      7. Whether photo shows acceptable progress (true/false)

                      Respond in JSON format:
                      {
                        "manualCompliance": 75,
                        "requirementsMet": ["surfaces dusted", "floor vacuumed"],
                        "requirementsMissed": ["baseboards", "window sills"],
                        "cleanlinessScore": 70,
                        "nextSteps": ["clean baseboards", "dust window sills"],
                        "confidence": 0.85,
                        "acceptableProgress": true
                      }`;
      
      // Create content parts with image and text
      const contentParts = [
        {
          text: prompt
        },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: preparedImage
          }
        }
      ];
      
      console.log(`Sending ${contentParts.length} content parts to Gemini API`);
      const result = await this.model.generateContent(contentParts, { generationConfig: { temperature: 0, top_p: 1 } });
      const response = await result.response;
      const responseText = response.text();
      console.log(`Received response from Gemini API: ${responseText.substring(0, 200)}...`);
      console.log(`Full response length: ${responseText.length} characters`);
      console.log(`Response starts with: "${responseText.substring(0, 50)}"`);
      
      return this.parsePhotoAnalysisResponse(responseText);
    } catch (error) {
      console.error('Photo analysis error:', error);
      
      // Check for specific API errors
      if (error.status === 429) {
        return {
          error: true,
          message: `I apologize, but I've reached the daily limit for AI photo analysis (quota exceeded). The system can only process 100 photo analyses per day on the free plan. Please try again tomorrow, or you can continue with the next step. Thank you for your patience! 🙏`,
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Please try again tomorrow when the quota resets"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // Check for authentication errors
      if (error.status === 401) {
        return {
          error: true,
          message: "I'm sorry, but there's an authentication issue with the AI service. The API key may be invalid or expired. Please contact support to resolve this issue. Thank you for your patience! 🔑",
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Contact support to fix the API authentication"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // Check for rate limiting (different from quota)
      if (error.status === 429 && error.errorDetails?.retryDelay) {
        const retryDelay = error.errorDetails.retryDelay;
        return {
          error: true,
          message: `I apologize, but I'm being rate limited by the AI service. Please wait ${retryDelay} before trying again. This is a temporary restriction to prevent overload. Thank you for your patience! ⏰`,
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: [`Wait ${retryDelay} before trying again`],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // Check for server errors
      if (error.status >= 500) {
        return {
          error: true,
          message: "I'm sorry, but the AI service is experiencing server issues right now. This is a temporary problem on their end. Please try again in a few minutes, or you can continue with the next step. Thank you for your patience! 🖥️",
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Please try again in a few minutes"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // Check for other client errors
      if (error.status >= 400 && error.status < 500) {
        return {
          error: true,
          message: `I'm sorry, but there's a client error (${error.status}) with the AI service. This might be due to invalid request format or unsupported image type. Please try with a different photo or contact support. Thank you for your patience! 📷`,
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Try with a different photo or contact support"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // For network or connection errors
      if (error.message && error.message.includes('fetch')) {
        return {
          error: true,
          message: "I'm sorry, but I can't connect to the AI service right now. This might be due to network issues or the service being temporarily unavailable. Please check your internet connection and try again. Thank you for your patience! 🌐",
          manualCompliance: 0,
          requirementsMet: [],
          requirementsMissed: [],
          cleanlinessScore: 0,
          nextSteps: ["Check internet connection and try again"],
          confidence: 0,
          acceptableProgress: false
        };
      }
      
      // For other unexpected errors
      return {
        error: true,
        message: `I apologize, but I encountered an unexpected error while analyzing your photos: ${error.message || 'Unknown error'}. Please try uploading the photos again, or if the issue persists, contact support. Thank you for your patience! ❓`,
        manualCompliance: 0,
        requirementsMet: [],
        requirementsMissed: [],
        cleanlinessScore: 0,
        nextSteps: ["Try uploading photos again or contact support"],
        confidence: 0,
        acceptableProgress: false
      };
    }
  }

  // Build before/after analysis prompt
  buildBeforeAfterAnalysisPrompt(beforePhotoBase64, afterPhotoBase64, roomType, manualRequirements) {
    return `Analyze these before and after photos of a ${roomType} for cleaning quality assessment.

            Manual Requirements for ${roomType}:
            ${manualRequirements}

            Please compare the before and after photos and provide:

            1. Overall cleanliness improvement score (0-100)
            2. Manual compliance score (0-100) - how well manual requirements were followed
            3. Specific improvements made (list each improvement)
            4. Manual requirements missed (list any requirements not met)
            5. Areas needing re-work (if any)
            6. Quality score breakdown:
              - Surface cleaning: 0-100
              - Detail work: 0-100
              - Manual compliance: 0-100
            7. Recommendations for improvement
            8. Whether the work meets manual standards (true/false)

            Respond in JSON format:
            {
              "overallScore": 85,
              "manualComplianceScore": 90,
              "improvements": ["dust removed", "surfaces cleaned"],
              "missedRequirements": ["baseboards not cleaned"],
              "reWorkAreas": ["baseboards"],
              "qualityBreakdown": {
                "surfaceCleaning": 90,
                "detailWork": 75,
                "manualCompliance": 90
              },
              "recommendations": ["clean baseboards", "check corners"],
              "meetsManualStandards": true
            }`;
  }

  // Build photo analysis with manual requirements
  buildPhotoAnalysisWithManualPrompt(photoBase64, photoType, roomType, manualRequirements) {
    return `Analyze this ${photoType} photo of a ${roomType} against manual requirements.

            Manual Requirements for ${roomType}:
            ${manualRequirements}

            Photo Type: ${photoType}

            Please provide:
            1. Manual compliance percentage (0-100)
            2. Requirements met (list specific requirements completed)
            3. Requirements missed (list specific requirements not met)
            4. Current cleanliness score (0-100)
            5. Next steps based on manual (specific actions needed)
            6. Confidence level (0-1)
            7. Whether photo shows acceptable progress (true/false)

            Respond in JSON format:
            {
              "manualCompliance": 75,
              "requirementsMet": ["surfaces dusted", "floor vacuumed"],
              "requirementsMissed": ["baseboards", "window sills"],
              "cleanlinessScore": 70,
              "nextSteps": ["clean baseboards", "dust window sills"],
              "confidence": 0.85,
              "acceptableProgress": true
            }`;
  }

  // Parse before/after analysis response
  parseBeforeAfterAnalysisResponse(response) {
    try {
      // Clean the response - remove markdown code blocks if present
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      // Handle cases where AI provides explanatory text before JSON
      const jsonMatch = cleanResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        cleanResponse = jsonMatch[1];
      } else {
        // Try to find JSON object in the response
        const jsonObjectMatch = cleanResponse.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          cleanResponse = jsonObjectMatch[0];
        }
      }
      
      const data = JSON.parse(cleanResponse);
      return {
        overallScore: data.overallScore || 0,
        manualComplianceScore: data.manualComplianceScore || 0,
        improvements: data.improvements || [],
        missedRequirements: data.missedRequirements || [],
        reWorkAreas: data.reWorkAreas || [],
        qualityBreakdown: data.qualityBreakdown || {
          surfaceCleaning: 0,
          detailWork: 0,
          manualCompliance: 0
        },
        recommendations: data.recommendations || [],
        meetsManualStandards: data.meetsManualStandards || false
      };
    } catch (error) {
      console.error('Failed to parse before/after analysis response:', error);
      console.error('Raw response:', response);
      
      // Check if the response indicates an image mismatch specifically
      if (response.toLowerCase().includes('mistake') && 
          (response.toLowerCase().includes('before') && response.toLowerCase().includes('after')) ||
          response.toLowerCase().includes('different') ||
          response.toLowerCase().includes('not the same') ||
          response.toLowerCase().includes('doesn\'t match') ||
          response.toLowerCase().includes('mismatch')) {
        return {
          error: true,
          message: "I'm sorry, but I detected that the before and after photos don't match. It seems like you may have uploaded photos of different rooms or different areas. Please make sure you upload the correct before and after photos for the same room. Thank you for your patience! 📸",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Upload the correct before and after photos for the same room"],
          meetsManualStandards: false
        };
      }
      
      // Check for other general errors or issues
      if (response.toLowerCase().includes('error') || 
          response.toLowerCase().includes('problem') ||
          response.toLowerCase().includes('cannot') ||
          response.toLowerCase().includes('unable')) {
        return {
          error: true,
          message: "I'm sorry, but I'm having trouble analyzing these photos. It seems there might be an issue with the image comparison. Could you please make sure you've uploaded the correct before and after photos for the same room? Thank you for your patience! 🙏",
          overallScore: 0,
          manualComplianceScore: 0,
          improvements: [],
          missedRequirements: [],
          reWorkAreas: [],
          qualityBreakdown: {
            surfaceCleaning: 0,
            detailWork: 0,
            manualCompliance: 0
          },
          recommendations: ["Please upload the correct before and after photos for the same room"],
          meetsManualStandards: false
        };
      }
      
      // For other parsing errors, provide a kind error message
      return {
        error: true,
        message: "I apologize, but I'm having difficulty analyzing these photos right now. Please try uploading the photos again, or if the issue persists, you can continue with the next step. Thank you for your understanding! 😊",
        overallScore: 0,
        manualComplianceScore: 0,
        improvements: [],
        missedRequirements: [],
        reWorkAreas: [],
        qualityBreakdown: {
          surfaceCleaning: 0,
          detailWork: 0,
          manualCompliance: 0
        },
        recommendations: ["Please try uploading the photos again"],
        meetsManualStandards: false
      };
    }
  }

  // Parse photo analysis response
  parsePhotoAnalysisResponse(response) {
    try {
      // Clean the response - remove markdown code blocks if present
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      const data = JSON.parse(cleanResponse);
      return {
        manualCompliance: data.manualCompliance || 0,
        requirementsMet: data.requirementsMet || [],
        requirementsMissed: data.requirementsMissed || [],
        cleanlinessScore: data.cleanlinessScore || 0,
        nextSteps: data.nextSteps || [],
        confidence: data.confidence || 0.5,
        acceptableProgress: data.acceptableProgress || false
      };
    } catch (error) {
      console.error('Failed to parse photo analysis response:', error);
      console.error('Raw response:', response);
      return this.getMockPhotoAnalysis();
    }
  }

  // Enhanced fallback response with better context awareness
  getEnhancedFallbackResponse(userMessage, taskId = null) {
    const lowerMessage = userMessage.toLowerCase();
    const context = this.getContext(taskId);
    
    // Get the last few messages for context
    const recentMessages = context.chatHistory.slice(-3);

    
    // Handle questions about why AI said something specific
    if (lowerMessage.includes('why') && lowerMessage.includes('say')) {
      return "I'm here to guide you through the cleaning process step by step! 🧹 Each message I send is designed to help you complete your cleaning tasks efficiently. What specific aspect of the cleaning would you like to focus on?";
    }
        
    // Handle simple photo type messages
    if (lowerMessage === 'before' || lowerMessage === 'after' || lowerMessage === 'during') {
      const { currentProperty, currentRoomIndex } = context;
      const allRooms = currentProperty?.requirements?.map(rt => rt.roomType) || [];
      const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
      
      return `Perfect! I'm ready for the ${currentRoom.toUpperCase()} ${userMessage.toUpperCase()} photo. Please upload a photo now by clicking the camera or paperclip icon.`;
    }
    
    if (lowerMessage.includes('welcome') || lowerMessage.includes('generate a welcome')) {
      if (context.currentProperty) {
        const property = context.currentProperty;
        return `🏠 Welcome to ${property.name}!

                📋 Property Details:
                • Address: ${property.address}
                • Type: ${property.type}
                • Square Footage: ${property.squareFootage} sq ft

                📖 Manual Overview:
                ${property.manual.content}

                ${property.specialRequirement ? `⚠️ Special Requirements:\n${property.specialRequirement}\n\n` : ''}
                I'm here to guide you through the cleaning process following the manual exactly${property.specialRequirement ? ' and paying special attention to the requirements above' : ''}. Let's start by taking BEFORE photos of each room. Which room would you like to start with?`;
      } else {
        return "Welcome to PropertySanta! I'm your AI assistant focused on manual-based cleaning guidance. How can I help you with your cleaning tasks today?";
      }
    }
    
    if (lowerMessage.includes('start') || lowerMessage.includes('begin')) {
      return "Great! Let's start cleaning following the manual. First, let me know which room you'd like to begin with, or I can guide you through the property systematically based on the manual requirements.";
    }
    
    // Handle questions about help
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you do')) {
      return "I can help you with cleaning tasks! 🧹 I can guide you through manual requirements, analyze before/after photos, provide scoring, and generate workflows. What would you like to work on?";
    }
    
    // Handle status inquiries
    if (lowerMessage.includes('how') && lowerMessage.includes('going')) {
      return "Everything's going well! 😊 I'm ready to help you with your cleaning tasks. What would you like to work on?";
    }
    
    // Default response - more conversational and varied
    const defaultResponses = [
      "I'm here to help with your cleaning tasks! 🧹 Just let me know what you'd like to work on - whether it's taking photos, getting manual requirements, or anything else. What can I assist you with?",
      "Ready to help with your cleaning! 🏠 What would you like to focus on today? I can guide you through the process step by step.",
      "I'm your cleaning assistant! ✨ Let me know what you need help with - whether it's understanding the manual, taking photos, or tracking your progress.",
      "Here to support your cleaning work! 🎯 What would you like to tackle first? I can help with any aspect of the cleaning process."
    ];
    
    // Use a different response based on message length or content
    const responseIndex = Math.abs(userMessage.length) % defaultResponses.length;
    return defaultResponses[responseIndex];
  }

  // Get current progress status
  getCurrentProgressStatus(taskId = null) {
    const context = this.getContext(taskId);
    const { currentProperty, currentRoomIndex, workflowState, beforePhotosLogged, afterPhotosLogged, scoringHistory } = context;
    
    if (!currentProperty) {
      return "We haven't started any cleaning tasks yet! 🏠 Let me know which property you'd like to work on, and I'll help you get started.";
    }
    
    const allRooms = currentProperty.requirements?.map(rt => rt.roomType) || [];
    const totalRooms = allRooms.length;
    const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
    
    let status = `📊 **Current Progress for ${currentProperty.name}**\n\n`;
    
    // Room progress
    status += `📍 **Current Room:** ${currentRoom.toUpperCase()} (${currentRoomIndex + 1}/${totalRooms})\n`;
    
    // Photo progress
    const beforeCount = beforePhotosLogged?.length || 0;
    const afterCount = afterPhotosLogged?.length || 0;
    status += `📸 **Photos Logged:** ${beforeCount} before, ${afterCount} after\n`;
    
    // Workflow state
    switch (workflowState) {
      case 'INITIAL':
        status += `🔄 **Status:** Ready to start - need to take BEFORE photos\n`;
        break;
      case 'BEFORE_PHOTOS_REQUESTED':
        status += `🔄 **Status:** Taking BEFORE photos for all rooms\n`;
        break;
      case 'BEFORE_PHOTOS_COMPLETED':
        status += `🔄 **Status:** BEFORE photos completed - ready for cleaning\n`;
        break;
      case 'CLEANING_IN_PROGRESS':
        status += `🔄 **Status:** Cleaning in progress - take AFTER photos when done\n`;
        break;
      case 'AFTER_PHOTOS_REQUESTED':
        status += `🔄 **Status:** Taking AFTER photos for scoring\n`;
        break;
      case 'COMPLETED':
        status += `✅ **Status:** All tasks completed!\n`;
        break;
      default:
        status += `🔄 **Status:** ${workflowState}\n`;
    }
    
    // Scoring info if available
    if (scoringHistory && Object.keys(scoringHistory).length > 0) {
      status += `\n📈 **Scoring:** ${Object.keys(scoringHistory).length} rooms scored\n`;
    }
    
    return status;
  }
  
  // Get next steps guidance
  getNextSteps(taskId = null) {
    const context = this.getContext(taskId);
    const { workflowState, currentRoomIndex, beforePhotosLogged, afterPhotosLogged } = context;
    const allRooms = context.currentProperty?.requirements?.map(rt => rt.roomType) || [];
    const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
    
    switch (workflowState) {
      case 'INITIAL':
        return "🚀 **Next Steps:** Let's start by taking BEFORE photos of each room. This helps us track your cleaning progress!";
      
      case 'BEFORE_PHOTOS_REQUESTED':
        if (beforePhotosLogged?.length < allRooms.length) {
          return `📸 **Next:** Take BEFORE photo for ${currentRoom.toUpperCase()} (${currentRoomIndex + 1}/${allRooms.length})`;
        } else {
          return "✅ **Next:** All BEFORE photos taken! You can now start cleaning. When you're done with a room, take an AFTER photo.";
        }
      
      case 'BEFORE_PHOTOS_COMPLETED':
        return "🧹 **Next:** Start cleaning! Follow the manual requirements for each room. Take AFTER photos when you finish each room.";
      
      case 'CLEANING_IN_PROGRESS':
        return `📸 **Next:** Take AFTER photo for ${currentRoom.toUpperCase()} to get your score!`;
      
      case 'AFTER_PHOTOS_REQUESTED':
        if (afterPhotosLogged?.length < allRooms.length) {
          return `📸 **Next:** Take AFTER photo for ${currentRoom.toUpperCase()} (${afterPhotosLogged.length + 1}/${allRooms.length})`;
        } else {
          return "🎉 **Next:** All rooms completed! I'll provide your final summary and payment information.";
        }
      
      case 'COMPLETED':
        return "✅ **All Done!** Your cleaning job is complete. You'll be paid by the property owner based on your quality scores.";
      
      default:
        return "🤔 **Next:** Let me know what you'd like to work on! I can help with photos, manual requirements, or scoring.";
    }
  }
  
  // Get room-specific information
  getRoomSpecificInfo(userMessage, taskId = null) {
    const context = this.getContext(taskId);
    const { currentProperty, currentRoomIndex } = context;
    if (!currentProperty) {
      return "We haven't started any property yet! 🏠 Let me know which property you'd like to work on.";
    }
    
    const allRooms = currentProperty.requirements?.map(rt => rt.roomType) || [];
    const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
    
    // Find which room they're asking about
    let targetRoom = currentRoom;
    if (userMessage.includes('bedroom')) targetRoom = 'bedroom';
    if (userMessage.includes('bathroom')) targetRoom = 'bathroom';
    if (userMessage.includes('kitchen')) targetRoom = 'kitchen';
    if (userMessage.includes('living')) targetRoom = 'living room';
    
    const roomTask = currentProperty.requirements?.find(rt => rt.roomType === targetRoom);
    if (!roomTask) {
      return `I don't see ${targetRoom} in the current property. Available rooms: ${allRooms.join(', ')}`;
    }
    
    return `🏠 **${targetRoom.toUpperCase()} Information:**
          • Key Requirements: ${roomTask.manualRequirements.join(', ')}
          • Current Status: ${this.getRoomStatus(targetRoom, context)}`;
  }
  
  // Get room status
  getRoomStatus(roomType, context) {
    const { beforePhotosLogged, afterPhotosLogged, scoringHistory } = context;
    const hasBefore = beforePhotosLogged?.includes(roomType);
    const hasAfter = afterPhotosLogged?.includes(roomType);
    const hasScore = scoringHistory?.[roomType];
    
    if (!hasBefore && !hasAfter) return "⏳ Not started";
    if (hasBefore && !hasAfter) return "🧹 Cleaning in progress";
    if (hasBefore && hasAfter && hasScore) return "✅ Completed and scored";
    if (hasBefore && hasAfter && !hasScore) return "📸 Photos taken, scoring pending";
    return "🔄 In progress";
  }
  
  // Get photo guidance
  getPhotoGuidance(taskId = null) {
    const context = this.getContext(taskId);
    const { workflowState, currentRoomIndex } = context;
    const allRooms = context.currentProperty?.requirements?.map(rt => rt.roomType) || [];
    const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
    
    if (workflowState === 'INITIAL' || workflowState === 'BEFORE_PHOTOS_REQUESTED') {
      return `📸 **BEFORE Photos:** Take photos of ${currentRoom.toUpperCase()} before cleaning to document the initial condition. Upload using the camera or paperclip icon!`;
    } else if (workflowState === 'AFTER_PHOTOS_REQUESTED' || workflowState === 'CLEANING_IN_PROGRESS') {
      return `📸 **AFTER Photos:** Take photos of ${currentRoom.toUpperCase()} after cleaning to get your quality score. Upload using the camera or paperclip icon!`;
    } else {
      return "📸 **Photos:** I can help you take BEFORE photos (to document initial condition) or AFTER photos (to get quality scores). Which would you like to do?";
    }
  }
  
  // Get manual requirements
  getManualRequirements(taskId = null) {
    const context = this.getContext(taskId);
    const { currentProperty, currentRoomIndex } = context;
    if (!currentProperty) {
      return "We haven't started any property yet! 🏠 Let me know which property you'd like to work on to see the manual requirements.";
    }
    
    const allRooms = currentProperty.requirements?.map(rt => rt.roomType) || [];
    const currentRoom = allRooms[currentRoomIndex] || 'bedroom';
    const roomTask = currentProperty.requirements?.find(rt => rt.roomType === currentRoom);
    
    if (!roomTask) {
      return `I don't see ${currentRoom} in the current property. Available rooms: ${allRooms.join(', ')}`;
    }
    
    return `📋 **${currentRoom.toUpperCase()} Manual Requirements:**
${roomTask.manualRequirements.map(req => `• ${req}`).join('\n')}`;
  }
  
  // Get scoring information
  getScoringInfo(taskId = null) {
    const context = this.getContext(taskId);
    const { scoringHistory } = context;
    
    if (!scoringHistory || Object.keys(scoringHistory).length === 0) {
      return "📊 **Scoring:** No scores yet! Take AFTER photos of cleaned rooms to get quality scores and grades.";
    }
    
    const rooms = Object.keys(scoringHistory);
    let info = `📊 **Scoring Summary:**\n`;
    
    rooms.forEach(room => {
      const score = scoringHistory[room];
      info += `• ${room.toUpperCase()}: ${score.overallScore}% (${score.grade})\n`;
    });
    
    const totalScore = rooms.reduce((sum, room) => sum + scoringHistory[room].overallScore, 0);
    const averageScore = Math.round(totalScore / rooms.length);
    
    info += `\n📈 **Average Score:** ${averageScore}%`;
    
    return info;
  }

  // Get mock before/after analysis (DEPRECATED - Use error handling instead)
  getMockBeforeAfterAnalysis(taskId = null) {
    console.warn('DEPRECATED: getMockBeforeAfterAnalysis called - should use error handling instead');
    return {
      error: true,
      message: "I'm sorry, but I encountered an error while analyzing your photos. Please try uploading them again, or if the issue persists, contact support. Thank you for your patience! ❓",
      overallScore: 0,
      manualComplianceScore: 0,
      improvements: [],
      missedRequirements: [],
      reWorkAreas: [],
      qualityBreakdown: {
        surfaceCleaning: 0,
        detailWork: 0,
        manualCompliance: 0
      },
      recommendations: ["Try uploading photos again or contact support"],
      meetsManualStandards: false
    };
  }

  // Prepare image for analysis (validate and ensure proper format)
  prepareImageForAnalysis(imageBase64) {
    try {
      // Check if base64 is valid
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        console.error('Invalid image data provided');
        return null;
      }
      
      // Remove any data URL prefix if present
      let cleanBase64 = imageBase64;
      if (imageBase64.includes(',')) {
        cleanBase64 = imageBase64.split(',')[1];
      }
      
      // Validate base64 format (very permissive - just check for reasonable length and valid chars)
      if (cleanBase64.length < 100 || !/^[A-Za-z0-9+/=_-]*$/.test(cleanBase64)) {
        console.error('Invalid base64 format');
        console.error('Base64 length:', cleanBase64.length);
        console.error('Base64 starts with:', cleanBase64.substring(0, 20));
        return null;
      }
      
      // Check size (Gemini has limits - roughly 20MB for images)
      const sizeInBytes = Math.ceil(cleanBase64.length * 0.75);
      const sizeInMB = sizeInBytes / (1024 * 1024);
      
      if (sizeInMB > 20) {
        console.warn(`Image too large (${sizeInMB.toFixed(2)}MB)`);
        return null;
      }
      
      console.log(`Image validated: ${sizeInMB.toFixed(2)}MB`);
      return cleanBase64;
      
    } catch (error) {
      console.error('Error preparing image for analysis:', error);
      return null;
    }
  }

  // Get enhanced mock photo analysis (DEPRECATED - Use error handling instead)
  getMockPhotoAnalysis(roomType = 'bedroom', photoType = 'after') {
    console.warn('DEPRECATED: getMockPhotoAnalysis called - should use error handling instead');
    return {
      error: true,
      message: "I'm sorry, but I encountered an error while analyzing your photo. Please try uploading it again, or if the issue persists, contact support. Thank you for your patience! ❓",
      manualCompliance: 0,
      requirementsMet: [],
      requirementsMissed: [],
      cleanlinessScore: 0,
      nextSteps: ["Try uploading photo again or contact support"],
      confidence: 0,
      acceptableProgress: false
    };
  }

  // Generate workflow guidance based on manual requirements
  async generateWorkflowGuidance(roomType, manualRequirements, currentProgress = 'Starting', taskId = null) {
    try {
      const prompt = this.buildWorkflowGuidancePrompt(roomType, manualRequirements, currentProgress);
      const result = await this.model.generateContent(prompt, { generationConfig: { temperature: 0, top_p: 1 } });
      const response = await result.response;
      return this.parseWorkflowGuidanceResponse(response.text());
    } catch (error) {
      console.error('Workflow guidance error:', error);
      return {
        error: true,
        message: "I'm sorry, but I'm having trouble generating workflow guidance right now. This might be due to a temporary issue with the AI service. Please try again in a moment, or you can continue with the manual requirements. Thank you for your patience! 📋",
        nextPriority: 'Continue with manual requirements',
        workflow: [],
        manualTips: [],
        qualityCheckpoints: [],
        safetyReminders: [],
        toolsNeeded: []
      };
    }
  }

  // Build workflow guidance prompt
  buildWorkflowGuidancePrompt(roomType, manualRequirements, currentProgress) {
    return `Generate step-by-step workflow guidance for cleaning a ${roomType} based on manual requirements.

            Manual Requirements for ${roomType}:
            ${manualRequirements}

            Current Progress: ${currentProgress}

            Please provide:
            1. Next priority task (most important next step)
            2. Step-by-step workflow (ordered list of tasks)
            3. Manual tips (specific tips from manual)
            4. Quality checkpoints (when to take photos)
            6. Safety reminders (if any)
            7. Tools needed for this room

            Respond in JSON format:
            {
              "nextPriority": "Clean baseboards thoroughly",
              "workflow": [
                "Dust all surfaces from top to bottom",
                "Clean baseboards with appropriate cleaner",
                "Vacuum floor thoroughly",
                "Mop floor with proper solution"
              ],
              "manualTips": ["Use microfiber cloths", "Check corners thoroughly"],
              "qualityCheckpoints": ["After dusting", "After baseboards", "Final inspection"],
              "safetyReminders": ["Wear gloves", "Ventilate room"],
              "toolsNeeded": ["Microfiber cloths", "All-purpose cleaner", "Vacuum", "Mop"]
            }`;
  }

  // Parse workflow guidance response
  parseWorkflowGuidanceResponse(response) {
    try {
      const data = JSON.parse(response);
      return {
        nextPriority: data.nextPriority || 'Continue with manual requirements',
        workflow: data.workflow || [],
        manualTips: data.manualTips || [],
        qualityCheckpoints: data.qualityCheckpoints || [],
        safetyReminders: data.safetyReminders || [],
        toolsNeeded: data.toolsNeeded || []
      };
    } catch (error) {
      console.error('Failed to parse workflow guidance response:', error);
      return {
        error: true,
        message: "I'm sorry, but I couldn't process the workflow guidance properly. There might be an issue with the AI response format. Please try again, or you can continue with the manual requirements. Thank you for your patience! 📋",
        nextPriority: 'Continue with manual requirements',
        workflow: [],
        manualTips: [],
        qualityCheckpoints: [],
        safetyReminders: [],
        toolsNeeded: []
      };
    }
  }

  // Get mock workflow guidance (DEPRECATED - Use error handling instead)
  getMockWorkflowGuidance(taskId = null) {
    console.warn('DEPRECATED: getMockWorkflowGuidance called - should use error handling instead');
    return {
      error: true,
      message: "I'm sorry, but I encountered an error while generating workflow guidance. Please try again, or you can continue with the manual requirements. Thank you for your patience! 📋",
      nextPriority: 'Continue with manual requirements',
      workflow: [],
      manualTips: [],
      qualityCheckpoints: [],
      safetyReminders: [],
      toolsNeeded: []
    };
  }
}

module.exports = new GeminiService(); 
const express = require('express');
const { auth } = require('../middleware/auth');
const aiController = require('../controllers/aiController');

const router = express.Router();

// Chat and workflow routes
router.post('/chat', auth, aiController.chatWithAI);
router.post('/upload-photo', auth, aiController.handlePhotoUpload);
router.post('/score-before-after', auth, aiController.scoreBeforeAfterPhotos);
router.post('/analyze-before-after', auth, aiController.analyzeBeforeAfterPhotos);
router.post('/analyze-photo-manual', auth, aiController.analyzePhotoWithManual);
router.post('/generate-workflow', auth, aiController.generateWorkflowGuidance);
router.post('/update-context', auth, aiController.updateContext);
router.post('/update-workflow-progress', auth, aiController.updateWorkflowProgress);
router.post('/reset-workflow', auth, aiController.resetWorkflow);
router.get('/workflow-state/:propertyId', auth, aiController.getWorkflowState);
router.get('/manual-requirements/:propertyId/:roomType', auth, aiController.getManualRequirements);
router.get('/chat-history/:taskId', auth, aiController.getChatHistory);
router.get('/scoring-history/:taskId', auth, aiController.getScoringHistory);
router.get('/property-scoring-summary/:propertyId', auth, aiController.getPropertyScoringSummary);
router.post('/save-chat-message', auth, aiController.saveChatMessageAPI);
router.post('/reset-context', aiController.resetAIContext); // reset AI context
router.post('/test-text-analysis', aiController.testTextAnalysis);
router.post('/test-photo-upload', aiController.handlePhotoUpload); // test endpoint without auth

module.exports = router;

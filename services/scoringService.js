const geminiService = require('./geminiService');

class ScoringService {
  constructor() {
    this.scoringHistory = new Map();
    this.workflowProgress = new Map();
  }

  // Score before/after photos and provide feedback
  async scoreBeforeAfterPhotos(beforePhotoBase64, afterPhotoBase64, roomType, propertyId, taskId) {
    try {
      // Get manual requirements for the room
      const manualRequirements = await this.getManualRequirements(propertyId, roomType);
      
      // Analyze before/after photos
      const analysis = await geminiService.analyzeBeforeAfterComparison(
        beforePhotoBase64,
        afterPhotoBase64,
        roomType,
        manualRequirements
      );

      // Calculate detailed scoring
      const scoringResult = this.calculateDetailedScore(analysis, manualRequirements);

      // Store scoring history
      this.scoringHistory.set(taskId, {
        timestamp: new Date(),
        roomType,
        propertyId,
        analysis,
        scoringResult,
        manualRequirements
      });

      return {
        success: true,
        data: {
          ...analysis,
          detailedScoring: scoringResult,
          recommendations: this.generateRecommendations(analysis, scoringResult)
        }
      };
    } catch (error) {
      console.error('Scoring error:', error);
      return {
        success: false,
        error: 'Failed to score photos'
      };
    }
  }

  // Calculate detailed scoring based on manual requirements
  calculateDetailedScore(analysis, manualRequirements) {
    const { overallScore, manualComplianceScore, qualityBreakdown } = analysis;
    
    // Calculate manual compliance breakdown
    const manualComplianceBreakdown = this.calculateManualComplianceBreakdown(analysis, manualRequirements);
    
    // Calculate quality metrics
    const qualityMetrics = {
      surfaceCleaning: qualityBreakdown.surfaceCleaning || 0,
      detailWork: qualityBreakdown.detailWork || 0,
      manualCompliance: qualityBreakdown.manualCompliance || 0,
      overallQuality: (qualityBreakdown.surfaceCleaning + qualityBreakdown.detailWork + qualityBreakdown.manualCompliance) / 3
    };

    // Calculate final score with weights
    const finalScore = this.calculateWeightedScore(analysis, qualityMetrics);

    return {
      finalScore,
      qualityMetrics,
      manualComplianceBreakdown,
      grade: this.calculateGrade(finalScore),
      meetsStandards: finalScore >= 80
    };
  }

  // Calculate manual compliance breakdown
  calculateManualComplianceBreakdown(analysis, manualRequirements) {
    const { requirementsMet, requirementsMissed } = analysis;
    
    // Parse manual requirements into individual tasks
    const manualTasks = manualRequirements.split('\n').filter(line => line.trim());
    
    const complianceBreakdown = {
      totalRequirements: manualTasks.length,
      requirementsMet: requirementsMet.length,
      requirementsMissed: requirementsMissed.length,
      compliancePercentage: (requirementsMet.length / manualTasks.length) * 100,
      detailedCompliance: {}
    };

    // Detailed compliance for each requirement
    manualTasks.forEach(task => {
      const isMet = requirementsMet.some(met => 
        met.toLowerCase().includes(task.toLowerCase().split(' ')[0])
      );
      complianceBreakdown.detailedCompliance[task] = isMet;
    });

    return complianceBreakdown;
  }

  // Calculate weighted score
  calculateWeightedScore(analysis, qualityMetrics) {
    const weights = {
      overallScore: 0.3,
      manualCompliance: 0.4,
      qualityMetrics: 0.3
    };

    const weightedScore = 
      (analysis.overallScore * weights.overallScore) +
      (analysis.manualComplianceScore * weights.manualCompliance) +
      (qualityMetrics.overallQuality * weights.qualityMetrics);

    return Math.round(weightedScore);
  }

  // Calculate grade based on score
  calculateGrade(score) {
    if (score >= 95) return 'A+';
    if (score >= 90) return 'A';
    if (score >= 85) return 'A-';
    if (score >= 80) return 'B+';
    if (score >= 75) return 'B';
    if (score >= 70) return 'B-';
    if (score >= 65) return 'C+';
    if (score >= 60) return 'C';
    if (score >= 55) return 'C-';
    if (score >= 50) return 'D+';
    if (score >= 45) return 'D';
    return 'F';
  }

  // Generate recommendations based on analysis
  generateRecommendations(analysis, scoringResult) {
    const recommendations = [];

    // Add recommendations based on missed requirements
    if (analysis.missedRequirements.length > 0) {
      recommendations.push({
        type: 'critical',
        title: 'Manual Requirements Missed',
        description: `The following manual requirements were not met: ${analysis.missedRequirements.join(', ')}`,
        action: 'Complete missed requirements before proceeding'
      });
    }

    // Add recommendations based on score
    if (scoringResult.finalScore < 80) {
      recommendations.push({
        type: 'warning',
        title: 'Quality Improvement Needed',
        description: `Current score (${scoringResult.finalScore}) is below the required standard (80)`,
        action: 'Review manual requirements and re-clean areas'
      });
    }

    // Add specific improvement recommendations
    if (analysis.reWorkAreas.length > 0) {
      recommendations.push({
        type: 'info',
        title: 'Areas Needing Re-work',
        description: `Focus on: ${analysis.reWorkAreas.join(', ')}`,
        action: 'Clean these areas according to manual specifications'
      });
    }

    // Add positive feedback for good work
    if (scoringResult.finalScore >= 90) {
      recommendations.push({
        type: 'success',
        title: 'Excellent Work!',
        description: 'Manual requirements were followed excellently',
        action: 'Continue with next room following same standards'
      });
    }

    return recommendations;
  }

  // Generate workflow guidance for a room
  async generateWorkflowGuidance(roomType, propertyId, currentProgress = 'Starting') {
    try {
      const manualRequirements = await this.getManualRequirements(propertyId, roomType);
      
      const guidance = await geminiService.generateWorkflowGuidance(
        roomType,
        manualRequirements,
        currentProgress
      );

      // Store workflow progress
      this.workflowProgress.set(`${propertyId}-${roomType}`, {
        roomType,
        propertyId,
        currentProgress,
        guidance,
        timestamp: new Date()
      });

      return {
        success: true,
        data: guidance
      };
    } catch (error) {
      console.error('Workflow guidance error:', error);
      return {
        success: false,
        error: 'Failed to generate workflow guidance'
      };
    }
  }

  // Get manual requirements for a room
  async getManualRequirements(propertyId, roomType) {
    try {
      const Property = require('../models/Property');
      const property = await Property.findById(propertyId);
      
      if (!property || !property.roomTasks) {
        return '';
      }

      const roomTask = property.roomTasks.find(rt => rt.roomType === roomType);
      if (!roomTask) {
        return '';
      }

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
    } catch (error) {
      console.error('Error getting manual requirements:', error);
      return '';
    }
  }

  // Get scoring history for a task
  getScoringHistory(taskId) {
    return this.scoringHistory.get(taskId) || null;
  }

  // Get workflow progress for a room
  getWorkflowProgress(propertyId, roomType) {
    return this.workflowProgress.get(`${propertyId}-${roomType}`) || null;
  }

  // Update workflow progress
  updateWorkflowProgress(propertyId, roomType, progress) {
    const key = `${propertyId}-${roomType}`;
    const current = this.workflowProgress.get(key) || {};
    
    this.workflowProgress.set(key, {
      ...current,
      currentProgress: progress,
      timestamp: new Date()
    });
  }

  // Get overall property scoring summary
  getPropertyScoringSummary(propertyId) {
    const propertyScores = Array.from(this.scoringHistory.values())
      .filter(score => score.propertyId === propertyId);

    if (propertyScores.length === 0) {
      return null;
    }

    const totalScore = propertyScores.reduce((sum, score) => 
      sum + score.scoringResult.finalScore, 0
    );
    const averageScore = totalScore / propertyScores.length;

    return {
      totalRoomsScored: propertyScores.length,
      averageScore: Math.round(averageScore),
      grade: this.calculateGrade(averageScore),
      meetsStandards: averageScore >= 80,
      roomBreakdown: propertyScores.map(score => ({
        roomType: score.roomType,
        score: score.scoringResult.finalScore,
        grade: score.scoringResult.grade,
        timestamp: score.timestamp
      }))
    };
  }
}

module.exports = new ScoringService(); 
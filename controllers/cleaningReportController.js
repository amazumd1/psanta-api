const Property = require('../models/Property');

const getCleaningReports = async (req, res) => {
  try {
    // Check total properties
    const totalProperties = await Property.countDocuments({});
    console.log(`Total properties in database: ${totalProperties}`);

    // Find completed or partially completed properties
    console.log('Fetching properties with completed tasks...');
    const properties = await Property.find({
      $or: [
        { completedAt: { $exists: true, $ne: null } },
        { 'roomTasks.tasks.isCompleted': true }
      ]
    })
    .populate('assignedTo', 'name email')
    .sort({ updatedAt: -1 })
    .lean();

    console.log(`Found ${properties.length} completed properties`);

    // Log properties for debugging
    properties.forEach((prop, index) => {
      console.log(`Property ${index + 1}:`, {
        _id: prop._id,
        name: prop.name || 'Unnamed',
        address: prop.address || 'No address',
        completedAt: prop.completedAt ? new Date(prop.completedAt).toISOString() : 'Not completed',
        roomTasks: prop.roomTasks?.length || 0,
        hasAssignedTo: !!prop.assignedTo,
        assignedTo: prop.assignedTo || 'Unassigned'
      });
    });

    // Transform properties for frontend
    const reports = properties.map(property => {
      const taskStats = property.roomTasks.reduce((acc, roomTask) => {
        acc.totalTasks += roomTask.tasks.length;
        acc.completedTasks += roomTask.tasks.filter(task => task.isCompleted).length;
        return acc;
      }, { totalTasks: 0, completedTasks: 0 });

      let duration = 'N/A';
      if (property.startedAt && property.completedAt) {
        const hours = (new Date(property.completedAt) - new Date(property.startedAt)) / (1000 * 60 * 60);
        duration = `${hours.toFixed(1)} hours`;
      }

      const rooms = [...new Set(property.roomTasks.map(room => room.roomType))];

      const unresolvedIssues = property.issues
        .filter(issue => !issue.isResolved)
        .map(issue => issue.description);

      const notes = property.issues
        .filter(issue => issue.notes)
        .map(issue => issue.notes)
        .join('\n');

      const completionPercentage = taskStats.totalTasks > 0
        ? Math.round((taskStats.completedTasks / taskStats.totalTasks) * 100)
        : 0;

      let status = completionPercentage === 100 ? 'completed' : 'in-progress';

      return {
        id: property._id.toString(),
        date: property.completedAt ? new Date(property.completedAt).toISOString().split('T')[0] : 'N/A',
        cleaner: property.assignedTo?.name || 'Unassigned',
        property: property.name || property.address || 'Unnamed Property',
        duration,
        rating: property.rating || 0,
        photos: property.photos?.length || 0,
        rooms,
        issues: unresolvedIssues,
        notes: notes || 'No notes available',
        status,
        completionPercentage,
        cleanerEmail: property.assignedTo?.email || '',
        address: property.address || '',
        completedAt: property.completedAt,
        startedAt: property.startedAt
      };
    });

    res.json({ success: true, properties: reports });

  } catch (error) {
    console.error('Get cleaning reports error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch cleaning reports',
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
};

module.exports = { getCleaningReports };

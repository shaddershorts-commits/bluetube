export default async function handler(req, res) {
  try {
    // Test probe endpoint for health check
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'BlueTube'
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
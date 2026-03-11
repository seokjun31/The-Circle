function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  const status = err.status || err.statusCode || 500;
  const message = err.message || '서버 오류가 발생했습니다.';

  res.status(status).json({ error: message });
}

module.exports = errorHandler;

export function allowedOrigins() {
  const origin = process.env.FRONTEND_ORIGIN;
  if (process.env.NODE_ENV === 'production') return origin ? [origin] : [];
  return [origin || 'http://localhost:5173', 'http://127.0.0.1:5173'];
}

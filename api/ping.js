// api/ping.js  —  Express도 안 씀. 바로 200 JSON.
export default function handler(req, res) {
  res.status(200).json({ pong: true, now: Date.now() });
}

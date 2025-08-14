// api/ok.js — 초경량 헬스체크(콜드스타트 측정용)
export default function handler(req, res) {
  res.status(200).send("OK - health");
}

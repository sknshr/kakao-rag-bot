// api/ok.js — 루트 헬스체크
export default function handler(req, res) {
  res.status(200).send("OK - kakao-rag-bot");
}
